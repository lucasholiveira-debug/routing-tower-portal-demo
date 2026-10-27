/* Shared navigation only: original cards, dialogs and content styles stay intact. */
(() => {
 const senior=window.RT_DEMO_DATA?.role==='analista_senior';
 const team=!!document.querySelector('.portal-sidebar');
 const side=document.querySelector(team?'.portal-sidebar':'.sidebar');
 if(!side)return;
 document.body.classList.add('navigation-shell',team?'team-shell':'analyst-shell');
 side.classList.add('unified-sidebar');side.id='panelNavigation';
 const paths={home:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',week:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 11h16',hubs:'M12 3v5 M5 16l7-8 7 8 M3 16h4v5H3z M17 16h4v5h-4z M10 3h4v4h-4z',timeoff:'M4 5h16v16H4z M8 3v4 M16 3v4 M8 15l3 3 5-6',overtime:'M12 8v5l3 2 M21 12a9 9 0 1 1-3-7 M18 2v6h6',links:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',operationView:'M3 4h18v16H3z M9 4v16 M9 10h12',dashboardsView:'M4 20V10h4v10 M10 20V4h4v16 M16 20v-7h4v7',visibilidadeView:'M3 5h18v15H3z M3 10h18 M9 5v15 M15 5v15',gerenciamentoView:'M4 7h16 M4 12h16 M4 17h16 M8 4v6 M16 9v6 M10 14v6',communicationView:'M3 4h18v13H8l-5 4z M7 8h10 M7 12h7',collapse:'M9 5l-7 7 7 7 M21 5l-7 7 7 7',menu:'M4 6h16 M4 12h16 M4 18h16'};
 const icon=key=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[key]+'"/></svg>';
 const personal=[['home','Visão geral'],['week','Minha semana'],['hubs','Meus hubs'],['timeoff','Folgas e férias'],['overtime','Horas extras'],['links','Links úteis']];
 function route(panel,view){if(window.parent!==window)window.parent.postMessage({type:'rt-navigation',panel,view},location.origin);}
 let nav=side.querySelector('nav');
 if(senior&&team){nav.replaceChildren();for(const [view,label] of personal){const b=document.createElement('button');b.type='button';b.className='tab-button';b.dataset.personalView=view;b.textContent=label;b.onclick=()=>route('analista',view);nav.append(b);}}
 if(senior){const b=document.createElement('button');b.type='button';b.className=team?'tab-button active':'nav-item';b.dataset.teamOperation='true';b.textContent='Operação';b.onclick=()=>{if(team){switchPortalView('operationView');close();}else route('supervisor','operationView');};nav.append(b);}
 const buttons=[...nav.querySelectorAll('button')];
 for(const b of buttons){const key=b.dataset.personalView||b.dataset.view||(b.dataset.teamOperation?'operationView':'home');const label=b.querySelector('.nav-label')?.textContent||b.textContent.trim();b.innerHTML=icon(key)+'<span class="nav-label">'+label+'</span>';b.setAttribute('aria-label',label);b.title=label;}
 const brand=side.querySelector(team?'.portal-brand':'.brand');
 if(senior&&team)brand.querySelector('small').textContent='Portal do analista sênior';
 const controls=document.createElement('div');controls.className='navigation-controls';
 const collapse=document.createElement('button');collapse.type='button';collapse.className='navigation-collapse';collapse.innerHTML=icon('collapse');collapse.setAttribute('aria-controls','panelNavigation');controls.append(collapse);brand.after(controls);
 let mobileButton=document.querySelector('.portal-menu-toggle');
 if(!mobileButton){mobileButton=document.createElement('button');mobileButton.type='button';mobileButton.className='portal-menu-toggle';document.querySelector('.topbar').prepend(mobileButton);}
 mobileButton.innerHTML=icon('menu')+'<span>Menu</span>';mobileButton.setAttribute('aria-label','Abrir navegação');mobileButton.setAttribute('aria-controls','panelNavigation');
 let overlay=document.querySelector('#sidebarOverlay');if(!overlay){overlay=document.createElement('button');overlay.id='sidebarOverlay';overlay.className='sidebar-overlay';overlay.hidden=true;overlay.setAttribute('aria-label','Fechar navegação');document.body.append(overlay);}
 const narrow=matchMedia('(max-width:760px)');let collapsed=sessionStorage.getItem('rt-navigation-collapsed')==='true';
 function sync(){const rail=collapsed&&!narrow.matches;document.body.classList.toggle('navigation-collapsed',rail);side.inert=narrow.matches&&!side.classList.contains('menu-open');collapse.setAttribute('aria-expanded',String(!rail));collapse.setAttribute('aria-label',narrow.matches?'Fechar navegação':rail?'Expandir navegação':'Recolher navegação');collapse.title=collapse.getAttribute('aria-label');mobileButton.setAttribute('aria-expanded',String(side.classList.contains('menu-open')));}
 function close(){side.classList.remove('menu-open');overlay.hidden=true;sync();}
 collapse.onclick=()=>{if(narrow.matches){close();mobileButton.focus();return;}collapsed=!collapsed;sessionStorage.setItem('rt-navigation-collapsed',String(collapsed));sync();};
 mobileButton.onclick=()=>{side.classList.add('menu-open');overlay.hidden=false;sync();collapse.focus();};overlay.onclick=()=>{close();mobileButton.focus();};narrow.addEventListener('change',close);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&side.classList.contains('menu-open')){close();mobileButton.focus();}if(e.key==='Tab'&&narrow.matches&&side.classList.contains('menu-open')){const focus=[...side.querySelectorAll('button,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length);const first=focus[0],last=focus.at(-1);if(e.shiftKey&&document.activeElement===first){last.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first.focus();e.preventDefault();}}});
 function active(button){buttons.forEach(b=>{b.classList.toggle('active',b===button);if(b===button)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});}
 for(const button of buttons){if(team&&!senior){button.onclick=()=>{switchPortalView(button.dataset.view);document.querySelector('#portalPageTitle').textContent=button.querySelector('.nav-label').textContent;active(button);close();if(button.dataset.view==='visibilidadeView')setTimeout(()=>{const sheet=document.querySelector('#visibilidadeView').shadowRoot?.getElementById('sheetBtn');if(sheet){sheet.disabled=true;sheet.title='Planilha disponível somente no ambiente conectado';}},20);};}else{button.addEventListener('click',()=>{if(!button.dataset.teamOperation&&!button.dataset.personalView)active(button);close();});}}
 if(team)brand.onclick=e=>{e.preventDefault();(senior?buttons.find(b=>b.dataset.teamOperation):buttons[0]).click();};
 const requested=new URLSearchParams(location.search).get('view');if(!team&&personal.some(([v])=>v===requested)){const ready=()=>{if(typeof state!=='undefined'&&state){buttons.find(b=>b.dataset.view===requested)?.click();return true;}return false;};if(!ready()){const observer=new MutationObserver(()=>{if(ready())observer.disconnect();});observer.observe(document.querySelector('main'),{childList:true,subtree:true});}}
 active(buttons.find(b=>b.classList.contains('active'))||buttons[0]);sync();
})();
