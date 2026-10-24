// Selection glide: a single highlight element springs between list items
// instead of the highlight jumping. Survives innerHTML re-renders of the list
// by re-inserting itself as the first child (so items paint above it).

function glide(list, selectedSelector, { easing, duration }) {
  if (!list) return;
  let ind = list.querySelector(':scope > .fx-glide');
  const fresh = !ind;
  if (fresh) {
    ind = document.createElement('li');
    ind.className = 'fx-glide';
    ind.setAttribute('aria-hidden', 'true');
    ind.setAttribute('role', 'presentation');
  }
  if (list.firstChild !== ind) list.insertBefore(ind, list.firstChild);
  list.classList.add('fx-glide-host');
  const sel = /** @type {HTMLElement|null} */ (list.querySelector(selectedSelector));
  if (!sel) { ind.hidden = true; return; }
  const wasHidden = ind.hidden;
  ind.hidden = false;
  ind.style.transition = fresh || wasHidden ? 'none' : `transform ${duration}ms ${easing}, height ${duration}ms ${easing}`;
  ind.style.height = `${sel.offsetHeight}px`;
  ind.style.width = `${sel.offsetWidth}px`;
  ind.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
}

module.exports = { glide };
