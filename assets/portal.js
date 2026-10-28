(() => {
const tabs=[document.querySelector('#loginTab'),document.querySelector('#demoTab')];
function selectTab(demo,focus=false){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===Number(demo)));tab.tabIndex=i===Number(demo)?0:-1;});document.querySelector('#loginPanel').hidden=demo;document.querySelector('#demoPanel').hidden=!demo;if(focus)(demo?document.querySelector('#demoRole'):tabs[0]).focus({preventScroll:true});}
tabs.forEach((tab,i)=>{tab.onclick=()=>selectTab(Boolean(i));tab.onkeydown=e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const demo=e.key==='End'||(e.key!=='Home'&&tab===tabs[0]);selectTab(demo);tabs[Number(demo)].focus();}};});
document.querySelector('#tryDemo').onclick=()=>selectTab(true,true);
document.querySelector('#accessForm').onsubmit=e=>e.preventDefault();
const profiles={supervisor:['Ambiente de demonstração','Navegue pelo painel com dados fictícios.'],analista:['Ambiente de demonstração','Navegue pelo painel com dados fictícios.'],analista_senior:['Ambiente de demonstração','Navegue pelo painel com dados fictícios.'],coordenador:['Ambiente de demonstração','Navegue pelo painel com dados fictícios.'],gerente:['Ambiente de demonstração','Navegue pelo painel com dados fictícios.']};
document.querySelector('#demoRole').onchange=e=>{const profile=profiles[e.target.value];document.querySelector('#profileName').textContent=profile[0];document.querySelector('#profileDescription').textContent=profile[1];};
document.querySelector('#loginForm').onsubmit=event=>{event.preventDefault();sessionStorage.setItem('rt-demo-role',document.querySelector('#demoRole').value);location.assign('./ambiente.html?v=20261027h');};
if(new URLSearchParams(location.search).has('entrar'))document.querySelector('#acesso').scrollIntoView({block:'center'});
const scene=document.querySelector('#brandScene'),object=document.querySelector('#brandObject');const motion=matchMedia('(prefers-reduced-motion: reduce)');let frame=0,currentX=-20,currentY=16,targetX=-20,targetY=16;
function animate(){currentX+=(targetX-currentX)*.075;currentY+=(targetY-currentY)*.075;object.style.transform=`rotateX(${currentY}deg) rotateY(${currentX}deg) rotateZ(-8deg)`;if(Math.abs(currentX-targetX)+Math.abs(currentY-targetY)>.05)frame=requestAnimationFrame(animate);else frame=0;}
function move(x,y){if(motion.matches)return;targetX=x;targetY=y;if(!frame)frame=requestAnimationFrame(animate);}
scene.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;const r=scene.getBoundingClientRect();move(-20+((e.clientX-r.left)/r.width-.5)*20,16-((e.clientY-r.top)/r.height-.5)*16);});scene.addEventListener('pointerleave',()=>move(-20,16));
motion.addEventListener('change',()=>{if(motion.matches){cancelAnimationFrame(frame);frame=0;object.style.transform='';}});
})();