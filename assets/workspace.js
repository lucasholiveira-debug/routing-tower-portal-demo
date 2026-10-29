(() => {
const roles={supervisor:'Supervisor',analista:'Analista',analista_senior:'Analista de apoio',coordenador:'Coordenador',gerente:'Gerente'};
let role=sessionStorage.getItem('rt-demo-role');if(!roles[role]){location.replace('./index.html?entrar=1&v=20261029a');return;}
const frame=document.querySelector('#panelFrame'),nav=document.querySelector('#areaNavigation');
document.querySelector('#userName').textContent='Ambiente de demonstração';document.querySelector('#userRole').textContent=roles[role];
const areas=role==='analista'?[['analista','Minha operação']]:role==='analista_senior'?[['analista','Minha operação']]:[['supervisor','Painel da equipe']];
function select(area,view){nav.querySelectorAll('button').forEach(b=>{const on=b.dataset.area===area[0];b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});document.querySelector('#workspaceLoading').hidden=false;frame.hidden=true;frame.src='./panels/'+area[0]+'.html?v=20261029a'+(view?'&view='+encodeURIComponent(view):'');document.querySelector('#areaDescription').textContent='Demonstração · dados fictícios · '+area[1];document.querySelector('#permissionLabel').textContent=area[0]==='supervisor'&&role!=='supervisor'?'Somente consulta':'Ações simuladas nesta aba';}
if(role==='analista_senior')nav.hidden=true;
window.addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==frame.contentWindow||role!=='analista_senior'||e.data?.type!=='rt-navigation')return;const {panel,view}=e.data;const personal=['home','week','hubs','timeoff','overtime','links'];if(panel==='supervisor'&&view==='operationView')select(['supervisor','Operação da equipe'],view);else if(panel==='analista'&&personal.includes(view))select(['analista','Minha operação'],view);});
for(const area of areas){const b=document.createElement('button');b.textContent=area[1];b.dataset.area=area[0];b.onclick=()=>select(area);nav.append(b);}
frame.onload=()=>{document.querySelector('#workspaceLoading').hidden=true;frame.hidden=false;};
document.querySelector('#profileSwitcher').value=role;document.querySelector('#profileSwitcher').onchange=e=>{sessionStorage.setItem('rt-demo-role',e.target.value);location.reload();};
document.querySelector('#logout').onclick=()=>{sessionStorage.removeItem('rt-demo-role');location.assign('./index.html?v=20261029a');};select(areas[0]);
})();