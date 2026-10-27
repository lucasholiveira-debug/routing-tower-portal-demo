(() => {
  const bar=document.querySelector('.portal-navbar'), toggle=document.querySelector('.portal-menu-toggle');
  const titles={operationView:'Operação da equipe',dashboardsView:'Dashboard gerencial',visibilidadeView:'Visibilidade Schedule',gerenciamentoView:'Gerenciamento',ticketsView:'Tickets'};
  toggle?.addEventListener('click',()=>{const open=bar.classList.toggle('menu-open');toggle.setAttribute('aria-expanded',String(open));});
  const activate=(id)=>{document.querySelector('#portalPageTitle').textContent=titles[id]||'Painel da equipe';document.querySelectorAll('.tab-button[data-view]').forEach(button=>button.setAttribute('aria-current',button.dataset.view===id?'page':'false'));bar.classList.remove('menu-open');toggle?.setAttribute('aria-expanded','false');};
  document.querySelectorAll('.tab-button[data-view]').forEach(button=>button.addEventListener('click',()=>activate(button.dataset.view)));
  document.querySelector('.portal-brand')?.addEventListener('click',event=>{event.preventDefault();document.querySelector('.tab-button[data-view="operationView"]')?.click();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){bar.classList.remove('menu-open');toggle?.setAttribute('aria-expanded','false');}});
  activate('operationView');
})();
