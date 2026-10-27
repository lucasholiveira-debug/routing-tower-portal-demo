(() => {
const dialog=document.querySelector('#loginDialog');
document.querySelectorAll('[data-login]').forEach(button=>button.addEventListener('click',()=>dialog.showModal()));
document.querySelector('#closeLogin').onclick=()=>dialog.close();
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
document.querySelector('#loginForm').onsubmit=event=>{event.preventDefault();sessionStorage.setItem('rt-demo-role',document.querySelector('#demoRole').value);location.assign('./ambiente.html');};
if(new URLSearchParams(location.search).has('entrar'))dialog.showModal();
})();