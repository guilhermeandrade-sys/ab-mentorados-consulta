# ab-mentorados-consulta

Ferramenta interna da AB Carreiras pra consultar, por fora do app da empresa terceira, o que existe
no banco da **Mentorado Platform PROD** (Supabase `mrrrucblahqqcmzmrtcr`) sobre cada mentorado:
progresso na trilha, respostas das ferramentas + parecer do mentor, histórico de revisão, e os
arquivos (upload do mentorado e upload feito pela equipe), com download.

## Como funciona

- `index.html` — página estática (sem build), publicada via GitHub Pages. Pede um código de acesso
  único (compartilhado com a equipe, não é login individual) e guarda no navegador depois de validado.
- `supabase/functions/staff-portal/` — função (Edge Function) hospedada no próprio projeto Supabase da
  Mentorado Platform. É ela quem de fato lê o banco, usando a chave de sistema — essa chave **nunca**
  fica neste repositório, só existe do lado do Supabase. A página só conversa com essa função.
- O código de acesso mora dentro da função (`STAFF_ACCESS_KEY`, em `index.ts`) — pra revogar ou trocar,
  editar essa constante e reimplantar a função no Supabase.

## Publicar / atualizar

1. Ativar GitHub Pages neste repositório uma vez: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
2. Qualquer alteração em `index.html` só precisa de commit + push nesta branch — o Pages atualiza sozinho.
3. Alteração em `supabase/functions/staff-portal/index.ts` precisa ser reimplantada manualmente no
  projeto Supabase (não é implantada automaticamente por este repositório).

## Limitações conhecidas

- Arquivos enviados pela equipe (`mentor_upload/…`) não têm registro de **quem** da equipe fez o
  upload — só de para qual mentorado é. Isso não é limitação desta ferramenta, é o app original que
  não grava essa informação.
- Sem controle de acesso por pessoa — é um código único pra toda a operação, por decisão do time.
