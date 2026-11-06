// Fixture state, never a connection to a live customer system.
fetch('/site/state.json').then(r=>r.json()).then(state=>{
  document.querySelector('#generation').innerHTML='Live<span> / generation '+state.generation+'</span>';
  fetch('/demo-ready?generation='+state.generation).catch(()=>{});
});
