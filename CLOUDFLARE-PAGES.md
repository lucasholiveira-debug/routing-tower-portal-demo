# Publicar o portal no Cloudflare Pages

Este repositorio contem a demonstracao publica com dados ficticios. O aplicativo e seus bancos locais nao fazem parte desta publicacao. A navegacao de perfis continua sendo demonstracao; a autenticacao real sera integrada em uma fase posterior.

## Configuracao do projeto

1. Crie a conta Cloudflare e confirme seu e-mail.
2. Em Workers & Pages, escolha criar um projeto **Pages** e conectar um repositorio Git existente. Nao escolha um projeto Workers.
3. Conecte o GitHub que possui acesso ao repositorio e autorize apenas `lucasholiveira-debug/routing-tower-portal-demo`.
4. Selecione o repositorio e use:

| Campo | Valor |
| --- | --- |
| Nome sugerido | `routing-tower-portal-demo` |
| Branch de producao | `main` |
| Framework preset | `None` |
| Build command | `node tools/build-pages.mjs` |
| Build output directory | `dist` |
| Root directory | raiz do repositorio (deixe vazio) |

Nenhuma variavel de ambiente ou segredo e necessario para esta demonstracao. O nome do projeto depende de disponibilidade; use o endereco pages.dev efetivamente retornado pela Cloudflare.

## Validacao

O build valida a sintaxe JavaScript e referencias locais src/href dos HTMLs antes de copiar somente `index.html`, `ambiente.html`, `assets/` e `panels/` para `dist/`. Arquivos Git, ferramentas e documentacao ficam fora da pasta publicada. Os headers permitem frames da mesma origem e exigem revalidacao do cache.

Depois da primeira publicacao, conferir no novo endereco:

- Boas-vindas e login demonstrativo.
- Explorar demonstracao nos cinco perfis.
- Analista de apoio: Minha operacao e acesso a Operacao da equipe.
- Menu lateral, colapso, Comunicacao e janelas operacionais.
- Troca de perfil, sair, recarregar pagina e tamanhos diferentes de tela.
- Ausencia de erros de carregamento dos arquivos e dos frames.

Manter o GitHub Pages existente ate conferir a publicacao Cloudflare. Nao configurar redirecionamento nem dominio definitivo antes dessa verificacao. As alteracoes futuras enviadas para main passam pelo build e geram publicacoes automaticamente. A criacao da conta e a autorizacao do GitHub dependem do titular.

Referencia: https://developers.cloudflare.com/pages/get-started/git-integration/
