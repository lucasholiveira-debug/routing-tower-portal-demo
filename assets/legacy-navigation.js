/* Navigation shell only. Content and cards are rendered by the original panels. */
(() => {
if(!document.querySelector('.portal-sidebar')){
 for(const id of ['update-portal-btn','export-update-btn']){const el=document.getElementById(id);if(el)el.hidden=true;}
 const connection=document.getElementById('connection-text');if(connection){const restore=()=>{connection.textContent='Demonstração · dados fictícios';};new MutationObserver(()=>{if(connection.textContent!=='Demonstração · dados fictícios')restore();}).observe(connection,{childList:true,subtree:true});restore();}
} else {
openAnalystPortal=function(token){const id=Number(String(token).split('-').pop())||1;window.open(new URL('./analista.html?v=20261027e&demo_analyst='+id,location.href).href,'_blank','noopener');};

if(window.RT_DEMO_DATA.readonly){const guard=()=>document.querySelectorAll('#gerenciamentoView [data-mg]').forEach(button=>{if(/^(new-|config$|settings$|reply$|save|delete|remove|archive|apply)/.test(button.dataset.mg)){button.disabled=true;button.title='Perfil de consulta';}});new MutationObserver(guard).observe(document.querySelector('#gerenciamentoView'),{childList:true,subtree:true});guard();}
}
})();
