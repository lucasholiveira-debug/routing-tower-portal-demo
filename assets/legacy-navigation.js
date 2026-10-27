/* Navigation shell only. Content and cards are rendered by the original panels. */
(() => {
if(!document.querySelector('.portal-sidebar')){
 for(const id of ['update-portal-btn','export-update-btn']){const el=document.getElementById(id);if(el)el.hidden=true;}
 const connection=document.getElementById('connection-text');if(connection){const restore=()=>{connection.textContent='Demonstração · dados fictícios';};new MutationObserver(()=>{if(connection.textContent!=='Demonstração · dados fictícios')restore();}).observe(connection,{childList:true,subtree:true});restore();}
 return;
}
openAnalystPortal=function(token){const id=Number(String(token).split('-').pop())||1;window.open(new URL('./analista.html?demo_analyst='+id,location.href).href,'_blank','noopener');};

if(window.RT_DEMO_DATA.readonly){const guard=()=>document.querySelectorAll('#gerenciamentoView [data-mg]').forEach(button=>{if(/^(new-|config$|settings$|reply$|save|delete|remove|archive|apply)/.test(button.dataset.mg)){button.disabled=true;button.title='Perfil de consulta';}});new MutationObserver(guard).observe(document.querySelector('#gerenciamentoView'),{childList:true,subtree:true});guard();}
const sidebar=document.querySelector('.portal-sidebar'),toggle=document.querySelector('.portal-menu-toggle'),overlay=document.querySelector('#sidebarOverlay'),narrow=matchMedia('(max-width:760px)');
function sync(){sidebar.inert=narrow.matches&&!sidebar.classList.contains('menu-open');if(!narrow.matches){overlay.hidden=true;sidebar.classList.remove('menu-open');toggle.setAttribute('aria-expanded','false');}}
function close(){sidebar.classList.remove('menu-open');overlay.hidden=true;toggle.setAttribute('aria-expanded','false');sync();}
toggle.onclick=()=>{const open=sidebar.classList.toggle('menu-open');toggle.setAttribute('aria-expanded',String(open));overlay.hidden=!open;sync();if(open)sidebar.querySelector('.tab-button.active')?.focus();};overlay.onclick=()=>{close();toggle.focus();};narrow.addEventListener('change',sync);sync();
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sidebar.classList.contains('menu-open')){close();toggle.focus();}});
sidebar.querySelectorAll('.tab-button[data-view]').forEach(button=>button.onclick=()=>{switchPortalView(button.dataset.view);if(button.dataset.view==='visibilidadeView')setTimeout(()=>{const sheet=document.querySelector('#visibilidadeView').shadowRoot?.getElementById('sheetBtn');if(sheet){sheet.disabled=true;sheet.title='Planilha disponível somente no ambiente conectado';}},20);document.querySelector('#portalPageTitle').textContent=button.querySelector('.nav-label').textContent;sidebar.querySelectorAll('.tab-button').forEach(b=>{if(b===button)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});close();});
sidebar.querySelector('.portal-brand').onclick=e=>{e.preventDefault();sidebar.querySelector('[data-view="operationView"]').click();};
})();