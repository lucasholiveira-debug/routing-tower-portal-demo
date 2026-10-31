# Routing Tower — Portal de demonstração

Teste público de navegação, com dados fictícios, separado do aplicativo principal.

## Como explorar

Abra a página inicial, use o cartão de acesso na própria página, selecione **Explorar demonstração** e escolha um perfil. O logo utiliza camadas em 3D, iluminação e animações suaves, com suporte à preferência de movimento reduzido.

A aba **Login** apresenta a interface de acesso futuro; seus campos ficam desativados até a integração do backend. Não existe autenticação real nesta demonstração.

- Supervisor: operação, visibilidade, gerenciamento e janelas de ações.
- Analista: escala individual, hubs, folgas, horas extras e links.
- Analista de apoio: sua operação e painel da equipe no mesmo ambiente; equipe em consulta.
- Coordenador e gerente: visão de equipes em consulta.

As ações indicadas como simulação ficam apenas nesta aba do navegador. Não gravam no app nem no Supabase. Seleção de perfis é navegação de demonstração, não controle de acesso.

## Publicação

Migracao para Cloudflare Pages preparada com integracao GitHub, branch `main`, build `node tools/build-pages.mjs` e pasta publicada `dist`. Veja [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md). O GitHub Pages permanece disponivel ate a validacao do novo endereco.

## Próxima fase

Conectar o backend com Supabase Auth, permissões e RLS validadas no servidor; integrar publicações, execução, DSR e transferências. Nenhum dado real, credencial, chave de API ou banco foi incluído.

## Organização do painel

A entrada é uma tela de boas-vindas comum a todos. Supervisor, coordenador e gerente usam menu lateral. Agenda, Links úteis e O que significa ficam em Comunicação. O topo reúne Ocorrências, Prévia da escala, Hubs sem analista e Atualizar.

## Layout original preservado

Os cards, os indicadores e os módulos internos usam os renderizadores originais dos HTMLs. As leituras da demonstração são respondidas em memória por `legacy-demo-data.js`; operações de gravação não são executadas. Constantes de conexão e referências de planilhas reais foram removidas. Tickets foi removido dos dois painéis, incluindo navegação, ajuda e código do módulo. A lateral é uma camada de navegação separada dos renderizadores.
