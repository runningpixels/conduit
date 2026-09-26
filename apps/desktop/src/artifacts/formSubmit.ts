/// Form submission inside the artifact frame.
///
/// The frame is sandboxed without `allow-forms` (ADR-007), and a browser then
/// drops a form submission *before* firing its `submit` event. Generated pages
/// almost always handle a form in script — `form.addEventListener('submit',
/// e => { e.preventDefault(); … })` — so a search box, an "add item" form or a
/// calculator did nothing at all when the button was pressed (found live on a
/// GitHub profile viewer, 2026-09-26).
///
/// This Conduit-owned script turns each attempt — a submit button's click,
/// Enter in a field of a form with no submit button, `requestSubmit()` — into
/// a synthetic, cancelable `submit` event after the usual validity check. It
/// only dispatches the event; nothing is submitted and nothing navigates, so
/// the sandbox flags stay as they are.

export const ARTIFACT_FORM_SUBMIT_SCRIPT =
  `(function(){` +
  `function submitter(t){var b=t&&t.closest?t.closest('button,input'):null;if(!b||!b.form)return null;` +
  `var ty=(b.getAttribute('type')||(b.tagName==='BUTTON'?'submit':'text')).toLowerCase();` +
  `return ty==='submit'||ty==='image'?b:null;}` +
  `function fire(form,by){if(!form.noValidate&&!(by&&by.formNoValidate)&&!form.checkValidity()){form.reportValidity();return;}` +
  `var ev;try{ev=new SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:by||null});}` +
  `catch(_){ev=new Event('submit',{bubbles:true,cancelable:true});}form.dispatchEvent(ev);}` +
  `document.addEventListener('click',function(e){var b=submitter(e.target);if(!b||b.disabled)return;` +
  `e.preventDefault();fire(b.form,b);},true);` +
  `document.addEventListener('keydown',function(e){if(e.key!=='Enter'||e.defaultPrevented||e.isComposing)return;` +
  `var t=e.target;if(!t||t.tagName!=='INPUT'||!t.form)return;` +
  `var ty=(t.getAttribute('type')||'text').toLowerCase();` +
  `if(['checkbox','radio','button','submit','reset','file','image','color','range'].indexOf(ty)>=0)return;` +
  // A form with a submit button gets a click on it from the browser (handled
  // above); only a form without one needs the event made here.
  `if(t.form.querySelector('button:not([type]),button[type=submit],input[type=submit],input[type=image]'))return;` +
  `e.preventDefault();fire(t.form,null);},true);` +
  `if(window.HTMLFormElement&&HTMLFormElement.prototype.requestSubmit){` +
  `HTMLFormElement.prototype.requestSubmit=function(by){fire(this,by||null);};}` +
  `})();`;
