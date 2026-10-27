# Routing Tower — Portal de demonstração

Teste público de navegação, com dados fictícios, separado do aplicativo principal.

## Como explorar

Abra a página inicial, use o cartão de acesso na própria página, selecione **Explorar demonstração** e escolha um perfil. O logo utiliza camadas em 3D, iluminação e animações suaves, com suporte à preferência de movimento reduzido.

A aba **Login** apresenta a interface de acesso futuro; seus campos ficam desativados até a integração do backend. Não existe autenticação real nesta demonstração.

- Supervisor: operação, dashboard, visibilidade, gerenciamento e janelas de ações.
- Analista: escala individual, hubs, folgas, horas extras e links.
- Analista sênior: sua operação e painel da equipe no mesmo ambiente; equipe em consulta.
- Coordenador e gerente: visão de equipes em consulta.

As ações indicadas como simulação ficam apenas nesta aba do navegador. Não gravam no app nem no Supabase. Seleção de perfis é navegação de demonstração, não controle de acesso.

## Publicação

GitHub Pages, branch `main`, pasta raiz. Os caminhos relativos permitem hospedar em um projeto do Pages.

## Próxima fase

Conectar o backend com Supabase Auth, permissões e RLS validadas no servidor; integrar publicações, execução, DSR e transferências. Nenhum dado real, credencial, chave de API ou banco foi incluído.
