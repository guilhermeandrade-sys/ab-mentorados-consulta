// Ferramenta interna de consulta (AB Carreiras) — NÃO faz parte do app dos mentorados.
// Lê o banco "Mentorado Platform PROD" com a chave de sistema (nunca exposta ao navegador)
// e devolve dados/URLs assinadas de arquivo pra uma página estática protegida por senha única.
//
// Ação de cada chamada vai em body.action: "list_mentees" | "mentee_data" | "signed_url"

import { createClient } from "npm:@supabase/supabase-js@2";

// Senha única compartilhada com o time de operações. O valor real só existe na função
// implantada no Supabase (Deploy → Functions → staff-portal) — não fica versionado aqui
// de propósito, pra não vazar no histórico do git. Pra trocar: editar o valor direto na
// implantação (ou pedir pro Claude Code fazer isso) e reimplantar.
const STAFF_ACCESS_KEY = "___DEFINIDA_SÓ_NA_IMPLANTAÇÃO___";

const BUCKET = "mentee-files";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Domínios/prefixos usados só por testes automatizados da empresa — fora do picker de mentorados.
function pareceContaDeTeste(email: string | undefined | null) {
  if (!email) return false;
  const e = email.toLowerCase();
  return e.startsWith("smoke-") || e.includes("@daltonlab.ai") || e.includes("+smoke");
}

function nomeExibicaoArquivo(rawName: string) {
  // remove prefixo "<timestamp>_" e, se sobrar, um uuid solto na frente — só cosmético.
  return rawName
    .replace(/^\d{10,}_/, "")
    .replace(/^[0-9a-f]{8}-[0-9a-f-]{27}(?=[._])/i, "");
}

function categoriaDoCaminho(path: string) {
  const partes = path.split("/");
  if (partes.length < 2) return "(sem categoria)";
  if (partes[1] === "mentor_upload") {
    return partes[2] ? `mentor_upload / ${partes[2]}` : "mentor_upload";
  }
  return partes[1];
}

async function listarStorageRecursivo(
  admin: ReturnType<typeof createClient>,
  prefix: string,
  depthMax = 4,
) {
  const arquivos: { path: string; created_at: string | null; size: number | null }[] = [];

  async function walk(path: string, depth: number) {
    if (depth > depthMax) return;
    const { data, error } = await admin.storage.from(BUCKET).list(path, {
      limit: 500,
      sortBy: { column: "name", order: "asc" },
    });
    if (error || !data) return;
    for (const item of data) {
      const fullPath = path ? `${path}/${item.name}` : item.name;
      const ehPasta = item.id === null; // pastas "virtuais" do storage não têm id
      if (ehPasta) {
        await walk(fullPath, depth + 1);
      } else {
        arquivos.push({
          path: fullPath,
          created_at: item.created_at ?? null,
          size: (item.metadata as any)?.size ?? null,
        });
      }
    }
  }

  await walk(prefix, 0);
  return arquivos;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "corpo inválido" }, 400);
  }

  if (body.accessKey !== STAFF_ACCESS_KEY) {
    return json({ error: "código de acesso incorreto" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (body.action === "list_mentees") {
      const mentorados: { id: string; nome: string; email: string; criado_em: string }[] = [];
      let page = 1;
      // pagina até esgotar — hoje são ~164 usuários, cabe folgado em poucas páginas de 1000
      while (true) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return json({ error: error.message }, 500);
        for (const u of data.users) {
          if (pareceContaDeTeste(u.email)) continue;
          mentorados.push({
            id: u.id,
            nome: (u.user_metadata as any)?.name || "(sem nome cadastrado)",
            email: u.email ?? "",
            criado_em: u.created_at,
          });
        }
        if (data.users.length < 1000) break;
        page += 1;
      }
      mentorados.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
      return json({ mentorados });
    }

    if (body.action === "mentee_data") {
      const userId = body.userId as string;
      if (!userId) return json({ error: "userId obrigatório" }, 400);

      const { data: userData, error: userErr } = await admin.auth.admin.getUserById(userId);
      if (userErr || !userData?.user) return json({ error: "mentorado não encontrado" }, 404);
      const email = userData.user.email ?? "";
      const nome = (userData.user.user_metadata as any)?.name || "(sem nome cadastrado)";

      const [checkpoints, forms, reviewsLegacy, arquivosCatalogados, storageObjs] =
        await Promise.all([
          admin.from("mentee_checkpoints").select("*").eq("user_id", userId)
            .order("created_at", { ascending: true }),
          admin.from("form_responses").select("*").eq("user_id", userId)
            .order("updated_at", { ascending: false }),
          email
            ? admin.from("review_events").select("*").eq("mentee_email", email)
              .order("created_at", { ascending: false })
            : Promise.resolve({ data: [], error: null } as any),
          admin.from("mentee_files").select("*").eq("user_id", userId)
            .order("uploaded_at", { ascending: false }),
          listarStorageRecursivo(admin, userId),
        ]);

      const formIds = (forms.data ?? []).map((f: any) => f.id);
      const reviewsVnext = formIds.length
        ? await admin.from("review_events_vnext").select("*").in("form_response_id", formIds)
          .order("occurred_at", { ascending: false })
        : { data: [], error: null };

      // junta o que está catalogado em mentee_files com o que só existe no storage bruto
      const porCaminho = new Map<string, any>();
      for (const f of arquivosCatalogados.data ?? []) {
        porCaminho.set(f.storage_path, {
          path: f.storage_path,
          nome: f.file_name,
          tipo: f.file_type,
          enviado_por: f.uploaded_by,
          data: f.uploaded_at,
          catalogado: true,
        });
      }
      for (const o of storageObjs) {
        if (porCaminho.has(o.path)) continue;
        porCaminho.set(o.path, {
          path: o.path,
          nome: nomeExibicaoArquivo(o.path.split("/").pop() ?? o.path),
          tipo: categoriaDoCaminho(o.path),
          enviado_por: o.path.includes("/mentor_upload/") ? "equipe (não registrado)" : "desconhecido",
          data: o.created_at,
          catalogado: false,
          tamanho: o.size,
        });
      }
      const arquivos = [...porCaminho.values()].sort((a, b) =>
        (b.data ?? "").localeCompare(a.data ?? "")
      );

      return json({
        mentorado: { id: userId, nome, email },
        progresso: checkpoints.data ?? [],
        formularios: forms.data ?? [],
        revisoes: {
          legado: reviewsLegacy.data ?? [],
          atual: (reviewsVnext as any).data ?? [],
        },
        arquivos,
      });
    }

    if (body.action === "signed_url") {
      const path = body.path as string;
      if (!path || path.includes("..")) return json({ error: "caminho inválido" }, 400);
      const { data, error } = await admin.storage.from(BUCKET)
        .createSignedUrl(path, 300, { download: true });
      if (error || !data) return json({ error: error?.message ?? "falha ao gerar link" }, 500);
      return json({ url: data.signedUrl });
    }

    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
