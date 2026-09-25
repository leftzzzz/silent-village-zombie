// Touch controls for phones/tablets: left virtual stick, right-side drag to look,
// action buttons. Feeds the same Input object used for keyboard/mouse.

export function isTouchDevice() {
  return (('ontouchstart' in window) || navigator.maxTouchPoints > 0) && matchMedia('(pointer: coarse)').matches;
}

export function setupTouch(input, onPause) {
  const root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="stick"><i></i></div>
    <div class="look"></div>
    <button data-b="fire" class="tb fire">开火</button>
    <button data-b="fire2" class="tb fire2">重击</button>
    <button data-e="jump" class="tb jump">跳</button>
    <button data-h="crouch" class="tb crouch">蹲</button>
    <button data-e="reload" class="tb reload">R</button>
    <button data-e="cycle" class="tb cycle">切枪</button>
    <button data-e="skill" class="tb skill">G</button>
    <button data-e="use" class="tb use">E</button>
    <button data-e="pause" class="tb pause">❚❚</button>
  `;
  document.body.appendChild(root);
  const css = document.createElement('style');
  css.textContent = `
    #touch { position: fixed; inset: 0; z-index: 12; pointer-events: none; touch-action: none; }
    #touch .stick { position: absolute; left: 4vw; bottom: 5vh; width: 130px; height: 130px; border-radius: 50%; background: rgba(255,255,255,.07); border: 2px solid rgba(255,220,170,.25); pointer-events: auto; }
    #touch .stick i { position: absolute; left: 50%; top: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgba(255,200,120,.35); }
    #touch .look { position: absolute; right: 0; top: 0; width: 55vw; height: 100%; pointer-events: auto; }
    #touch .tb { position: absolute; pointer-events: auto; border-radius: 50%; border: 2px solid rgba(255,220,170,.35); background: rgba(20,14,10,.45); color: #ffe2b0; font-size: 13px; font-weight: 700; width: 50px; height: 50px; padding: 0; }
    #touch .tb.on { background: rgba(255,150,40,.45); }
    #touch .fire { right: 3vw; bottom: 30vh; width: 74px; height: 74px; font-size: 15px; }
    #touch .fire2 { right: calc(3vw + 84px); bottom: 20vh; }
    #touch .jump { right: 3vw; bottom: 6vh; }
    #touch .crouch { right: calc(3vw + 62px); bottom: 3vh; }
    #touch .reload { right: calc(3vw + 88px); bottom: calc(20vh + 62px); }
    #touch .cycle { right: calc(3vw + 12px); bottom: calc(30vh + 84px); font-size: 11px; }
    #touch .skill { right: calc(3vw + 150px); bottom: 12vh; }
    #touch .use { right: calc(3vw + 150px); bottom: calc(12vh + 60px); }
    #touch .pause { left: 50%; top: 8px; transform: translateX(-50%); width: 40px; height: 40px; font-size: 12px; top: 64px; }
  `;
  document.head.appendChild(css);

  const stick = root.querySelector('.stick'), knob = stick.firstElementChild;
  let stickId = null, sx = 0, sy = 0;
  stick.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0]; stickId = t.identifier;
    const r = stick.getBoundingClientRect(); sx = r.left + r.width / 2; sy = r.top + r.height / 2;
    e.preventDefault();
  }, { passive: false });
  const moveStick = (t) => {
    let dx = t.clientX - sx, dy = t.clientY - sy;
    const d = Math.hypot(dx, dy), max = 60;
    if (d > max) { dx *= max / d; dy *= max / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    input.touchMove = { x: dx / max, y: -dy / max };
  };
  let lookId = null, lx = 0, ly = 0;
  const look = root.querySelector('.look');
  look.addEventListener('touchstart', (e) => { const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; e.preventDefault(); }, { passive: false });
  root.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) moveStick(t);
      if (t.identifier === lookId) { input.mx = (input.mx || 0) + (t.clientX - lx) * 1.6; input.my = (input.my || 0) + (t.clientY - ly) * 1.6; lx = t.clientX; ly = t.clientY; }
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; knob.style.transform = ''; input.touchMove = null; }
      if (t.identifier === lookId) lookId = null;
    }
  };
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', end);

  for (const b of root.querySelectorAll('.tb')) {
    const hold = b.dataset.b || b.dataset.h, ev = b.dataset.e;
    b.addEventListener('touchstart', (e) => {
      e.preventDefault(); e.stopPropagation();
      b.classList.add('on');
      if (hold === 'fire') input.state.fire = true;
      if (hold === 'fire2') input.state.fire2 = true;
      if (hold === 'crouch') input.touchCrouch = !input.touchCrouch;
      if (ev === 'pause') onPause();
      else if (ev === 'cycle') { input.cycle = ((input.cycle || 0) % 4) + 1; input.events.add('slot' + input.cycle); }
      else if (ev) input.events.add(ev);
    }, { passive: false });
    b.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (hold !== 'crouch' || !input.touchCrouch) b.classList.remove('on');
      if (hold === 'fire') input.state.fire = false;
      if (hold === 'fire2') input.state.fire2 = false;
    }, { passive: false });
  }
  return root;
}
