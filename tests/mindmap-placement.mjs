// Run with a local server on port 8000 and Chrome's remote debugging on 9222:
// node tests/mindmap-placement.mjs
// Uses browser measurements and real input events; no npm dependencies.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const tabs = await fetch('http://127.0.0.1:9222/json').then(response => response.json());
const tab = tabs.find(tab => tab.type === 'page');
assert.ok(tab, 'Chrome needs an open page');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (pending.has(message.id)) {
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

try {
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Network.setBypassServiceWorker', { bypass: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: 'http://127.0.0.1:8000/mindmapplain.html' });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("typeof isInitialized !== 'undefined' && isInitialized")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate('isInitialized'), true, 'Page initialized');
  await evaluate(`
    window.check = (condition, label) => { if (!condition) throw new Error(label); };
    window.fixtureNode = (id, parentId, x, y, text = id) => ({ id, parentId, x, y, text, color: '#FFFFFF' });
    window.resetMap = (extra = []) => {
      if (document.activeElement) document.activeElement.blur();
      nodesData = [fixtureNode(centralNodeId, null, 500, 350, 'Main topic'), ...extra];
      undoStack = []; redoStack = []; panX = 0; panY = 0;
      urlStorageEnabled = false; interactionMode = 'edit';
      renderMindMap(); setSelectedNode(centralNodeId);
    };
    window.lastNode = () => nodesData[nodesData.length - 1];
    window.rectFor = id => getPlacementSnapshot().byId.get(id);
    window.assertClear = id => {
      const a = rectFor(id);
      nodesData.filter(node => node.id !== id).forEach(node => {
        const b = rectFor(node.id);
        check(a.right + NODE_GAP <= b.x + 0.01 || b.right + NODE_GAP <= a.x + 0.01 ||
          a.bottom + NODE_GAP <= b.y + 0.01 || b.bottom + NODE_GAP <= a.y + 0.01,
          'New node overlaps ' + node.id);
      });
    };
    window.assertVisible = id => {
      const rect = document.getElementById(id).getBoundingClientRect();
      const toolbar = document.getElementById('toolbar-dock').getBoundingClientRect();
      const viewport = window.visualViewport;
      check(rect.left >= viewport.offsetLeft + 23 && rect.right <= viewport.offsetLeft + viewport.width - 23,
        'New node is horizontally visible');
      check(rect.top >= Math.max(viewport.offsetTop, toolbar.bottom) + 23 &&
        rect.bottom <= viewport.offsetTop + viewport.height - 23, 'New node is above keyboard / below toolbar');
    };
  `);

  const cases = [
    ['Balanced main branches; outward children; stable existing positions', `
      resetMap();
      addNode(centralNodeId); const right = lastNode();
      addNode(centralNodeId); const left = lastNode();
      check(right.x > rectFor(centralNodeId).right, 'First branch is right');
      check(rectFor(left.id).right < nodesData[0].x, 'Second branch is left');
      const positions = nodesData.map(({id, x, y}) => ({id, x, y}));
      addNode(left.id); const child = lastNode();
      check(rectFor(child.id).right < left.x, 'Left child grows outward');
      positions.forEach(old => { const node = nodesData.find(n => n.id === old.id);
        check(node.x === old.x && node.y === old.y, 'Existing position preserved'); });
      assertClear(child.id);
    `],
    ['Sibling insertion leaves room for descendants and unrelated nodes', `
      resetMap([
        fixtureNode('branch', centralNodeId, 800, 250, 'Branch'),
        fixtureNode('descendant', 'branch', 1040, 390, 'Descendant'),
        fixtureNode('obstacle', null, 800, 500, 'Unrelated image-sized block')
      ]);
      document.getElementById('obstacle').style.height = '140px';
      const old = JSON.stringify(nodesData);
      addSiblingNode('branch'); const added = lastNode();
      check(added.parentId === centralNodeId && added.x === 800, 'Sibling alignment and parent');
      check(added.y >= 640 + NODE_GAP, 'Skips tall unrelated obstacle');
      check(JSON.stringify(nodesData.slice(0, -1)) === old, 'No existing nodes moved');
      assertClear(added.id);
      undo(); check(JSON.stringify(nodesData) === old, 'Undo restores map');
      redo(); check(lastNode().id === added.id, 'Redo restores inserted node');
    `],
    ['Wide parent and left label growth use measured widths', `
      resetMap([fixtureNode('wide', centralNodeId, 800, 300, 'A very wide parent label with room for many words')]);
      const parentRight = rectFor('wide').right;
      addNode('wide'); check(lastNode().x >= parentRight + BRANCH_GAP, 'Measured parent edge');
      addNode(centralNodeId); const left = lastNode(); const anchor = rectFor(left.id).right;
      const editor = document.getElementById(left.id);
      editor.textContent = 'A much longer label that grows away from the main topic';
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      check(Math.abs(rectFor(left.id).right - anchor) < 1, 'Left edge anchor survives typing');
      assertClear(left.id);
      renderMindMap(); check(Math.abs(rectFor(left.id).right - anchor) < 1, 'Anchor survives render');
    `],
    ['Children grow into nearby space without mixing neighbouring branches', `
      resetMap();
      addNode(centralNodeId); const first = lastNode();
      addNode(first.id); addNode(first.id);
      addNode(centralNodeId); const second = lastNode();
      addNode(second.id); addNode(second.id);
      addNode(centralNodeId); const third = lastNode();
      addNode(third.id); addNode(third.id);
      const snapshot = getPlacementSnapshot();
      const a = snapshot.boundsFor(first.id); const b = snapshot.boundsFor(third.id);
      check(a.bottom + NODE_GAP <= b.y || b.bottom + NODE_GAP <= a.y, 'Branches occupy separate vertical bands');
      nodesData.forEach(node => assertClear(node.id));
    `],
    ['Toolbar retains disconnected nodes; keyboard centre Enter stays connected', `
      resetMap();
      document.getElementById('add-node-btn').click(); const detached = lastNode();
      check(detached.parentId === null, 'Button creates disconnected node'); assertClear(detached.id);
      document.getElementById('add-node-btn').click();
      check(lastNode().parentId === null, 'Disconnected root also supports a disconnected sibling');
      setSelectedNode(centralNodeId);
      document.getElementById(centralNodeId).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
      check(lastNode().parentId === centralNodeId, 'Enter creates a branch');
      document.getElementById('add-child-btn').click();
      check(lastNode().parentId !== null, 'Child button stays connected');
    `],
    ['Crowded map has no eight-position limit or screen-height clamping', `
      resetMap();
      for (let i = 0; i < 36; i++) { addNode(centralNodeId); assertClear(lastNode().id); }
      check(nodesData.some(node => node.y < 0 || node.y > innerHeight), 'Map can grow beyond viewport');
      assertVisible(lastNode().id);
    `],
    ['Placement uses world coordinates after panning, and reveals new editor', `
      resetMap(); panX = -1900; panY = 1400; updateCanvasTransform();
      const root = {...nodesData[0]}; addNode(centralNodeId);
      check(lastNode().x === root.x + rectFor(centralNodeId).width + 100, 'Pan does not affect placement');
      check(nodesData[0].x === root.x && nodesData[0].y === root.y, 'Root stays fixed');
      assertVisible(lastNode().id);
    `],
    ['Manual dragging releases the left anchor', `
      resetMap(); addNode(centralNodeId); addNode(centralNodeId); const left = lastNode();
      const el = document.getElementById(left.id); const rect = el.getBoundingClientRect();
      startDrag({clientX: rect.left + 10, clientY: rect.top + 10}, left.id);
      dragNode({clientX: rect.left + 50, clientY: rect.top + 70, type: 'mousemove'});
      stopDrag(); check(!('placementRight' in left), 'Manual position no longer anchored');
      const x = left.x; renderMindMap(); check(left.x === x, 'Manual position survives render');
    `],
    ['Tidy layout respects measured nodes, anchors and current pan', `
      resetMap(); addNode(centralNodeId); addNode(centralNodeId);
      const left = lastNode(); addNode(left.id);
      nodesData[0].text = 'A wide central topic'; renderMindMap();
      panX = 120; panY = -75; updateCanvasTransform(); autoLayout();
      nodesData.forEach(node => assertClear(node.id));
      const root = rectFor(centralNodeId);
      check(Math.abs(root.x + root.width / 2 + panX - innerWidth / 2) < 1, 'Tidy centres in visible map');
      renderMindMap(); nodesData.forEach(node => assertClear(node.id));
    `]
  ];
  for (const [name, code] of cases) {
    await evaluate(`(() => { ${code} })()`);
    console.log(`PASS ${name}`);
  }

  await evaluate(`
    window.twoFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.dragFixture = () => {
      resetMap([
        fixtureNode('branch', centralNodeId, 500, 300, 'Move this idea'),
        fixtureNode('child-a', 'branch', 820, 220, 'First detail'),
        fixtureNode('child-b', 'branch', 820, 420, 'Second detail'),
        fixtureNode('separate', null, 220, 650, 'Disconnected'),
        fixtureNode('separate-child', 'separate', 500, 650, 'Unchanged detail')
      ]);
      nodesData[0].x = 180;
      for (let i = 0; i < 250; i++) nodesData.push(fixtureNode('extra-' + i, 'separate', 1300 + (i % 10) * 200, 100 + Math.floor(i / 10) * 90));
      interactionMode = 'move'; renderMindMap();
    };
    window.watchLines = () => {
      window.lineMutations = [];
      window.lineWatcher = new MutationObserver(records => lineMutations.push(...records));
      lineWatcher.observe(svg, {subtree: true, childList: true, attributes: true, attributeFilter: ['x1','x2','y1','y2']});
    };
    dragFixture();
  `);
  await evaluate('twoFrames()');
  const selective = await evaluate(`(async () => {
    const elements = new Map(nodeElements);
    const lines = new Map(connectionElements);
    const initial = {...nodesById.get('branch')};
    watchLines();
    const originalRect = Element.prototype.getBoundingClientRect;
    let geometryReads = 0;
    Element.prototype.getBoundingClientRect = function() { geometryReads++; return originalRect.call(this); };
    try {
      startDrag({clientX: 530, clientY: 320}, 'branch');
      for (let i = 1; i <= 100; i++) dragNode({clientX: 530 + i, clientY: 320 + i / 2, type: 'mousemove'});
      check(nodesById.get('branch').x === initial.x, 'Input is coalesced before painting');
      await twoFrames();
      check(nodesById.get('branch').x === initial.x + 100 && nodesById.get('branch').y === initial.y + 50, 'Latest input wins');
      check(nodeElements.get('branch').style.left === initial.x + 'px', 'Dragging uses transform, not layout positions');
      check(geometryReads === 0, 'No per-node rectangle reads during dragging');
      const touched = [...new Set(lineMutations.filter(r => r.type === 'attributes').map(r => r.target.dataset.childId))].sort();
      check(JSON.stringify(touched) === JSON.stringify(['branch','child-a','child-b']), 'Only the three attached connectors changed');
      check(lineMutations.every(r => r.type !== 'childList'), 'No connectors replaced');
      elements.forEach((el, id) => check(nodeElements.get(id) === el, 'Node retained: ' + id));
      lines.forEach((el, id) => check(connectionElements.get(id) === el, 'Connector retained: ' + id));
      check(getComputedStyle(nodeElements.get('branch')).filter === 'none', 'Dragged text stays sharp');
      return {nodes: nodesData.length, connectors: connectionElements.size, changedConnectors: touched.length, geometryReads};
    } finally { Element.prototype.getBoundingClientRect = originalRect; lineWatcher.disconnect(); }
  })()`);
  console.log('PASS selective drag:', JSON.stringify(selective));
  const dragScreenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/mindmap-dragging.png', Buffer.from(dragScreenshot.data, 'base64'));
  await evaluate(`
    stopDrag(); check(undoStack.length === 1, 'One completed drag is one undo step');
    check(nodeElements.get('branch').style.transform === '', 'Transient transform is cleared');
    undo(); check(nodesById.get('branch').x === 500 && nodesById.get('branch').y === 300, 'Undo restores position');
    redo(); check(nodesById.get('branch').x === 600 && nodesById.get('branch').y === 350, 'Redo restores drag');
  `);
  console.log('PASS dragging commits one undo step and clears transient styling');

  await evaluate(`(async () => {
    dragFixture(); await twoFrames();
    const before = JSON.stringify(nodesData);
    startDrag({clientX: 530, clientY: 320}, 'branch');
    dragNode({clientX: 532, clientY: 321, type:'mousemove'}); stopDrag();
    check(JSON.stringify(nodesData) === before && undoStack.length === 0, 'Small tap movement is not a drag');
    startDrag({clientX: 530, clientY: 320}, 'branch');
    dragNode({clientX: 630, clientY: 350, type:'mousemove'}); await twoFrames();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    check(JSON.stringify(nodesData) === before && undoStack.length === 0, 'Escape rolls back drag');
    check(!dragSession && !document.querySelector('.dragging, .drop-target, .connection-active'), 'Cancellation cleans up feedback');
    startDrag({clientX: 530, clientY: 320}, 'branch');
    dragNode({clientX: 0, clientY: 0, type:'mousemove'}); stopDrag();
    check(nodesById.get('branch').x === -30 && nodesById.get('branch').y === -20, 'Screen coordinate zero is valid');
  })()`);
  console.log('PASS tap threshold, Escape cancellation, and zero coordinates');

  await evaluate(`(async () => {
    resetMap([fixtureNode('editor', centralNodeId, 800, 300, 'Keep this selection')]);
    focusNode('editor'); await twoFrames();
    const editor = nodeElements.get('editor'); const text = editor.firstChild;
    const range = document.createRange(); range.setStart(text, 5); range.collapse(true);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const line = connectionElements.get('editor');
    changeNodeColor('#FFD700');
    check(nodeElements.get('editor') === editor && editor.firstChild === text, 'Colour does not replace editor');
    check(selection.anchorNode === text && selection.anchorOffset === 5, 'Caret survives colour change');
    check(connectionElements.get('editor') === line, 'Colour retains connector');
    addNode(centralNodeId);
    check(nodeElements.get('editor') === editor && connectionElements.get('editor') === line, 'Adding retains existing DOM');
    const added = lastNode().id; deleteSelectedNode();
    check(!nodeElements.has(added) && !connectionElements.has(added), 'Deletion removes cached elements');
    undo(); check(nodeElements.has(added) && connectionElements.has(added), 'Undo restores deleted elements');
  })()`);
  console.log('PASS retained DOM preserves editing selection and handles add/delete/undo');

  // Actual browser pointer events exercise capture and hit testing during reparenting.
  await evaluate(`
    resetMap([fixtureNode('moving', centralNodeId, 350, 300, 'Moving'), fixtureNode('target', centralNodeId, 800, 300, 'New parent')]);
    nodesData[0].x = 100; interactionMode = 'move'; renderMindMap();
  `);
  await evaluate('twoFrames()');
  await command('Input.dispatchMouseEvent', {type: 'mousePressed', x: 380, y: 320, button: 'left', clickCount: 1});
  await command('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 830, y: 320, button: 'left', buttons: 1});
  await evaluate('twoFrames()');
  await evaluate(`check(currentDropTarget?.id === 'target', 'Pointer hit testing finds target under dragged card'); check(container.hasPointerCapture(dragSession.pointerId), 'Drag retains pointer capture');`);
  await command('Input.dispatchMouseEvent', {type: 'mouseReleased', x: 830, y: 320, button: 'left', clickCount: 1});
  await evaluate(`
    check(nodesById.get('moving').parentId === 'target', 'Drop reparents node'); assertClear('moving');
    check(undoStack.length === 1 && !dragSession, 'Reparent is one completed action');
    undo(); check(nodesById.get('moving').parentId === centralNodeId && nodesById.get('moving').x === 350, 'Undo restores parent and position');
  `);
  console.log('PASS real mouse capture, drop target, reparenting and undo');

  await evaluate(`(async () => {
    dragFixture(); await twoFrames();
    startDrag({clientX:530, clientY:320}, 'branch');
    dragNode({clientX:850, clientY:240, type:'mousemove'}); await twoFrames();
    check(currentDropTarget === null, 'Descendant is not a valid drop target'); cancelDrag();
    watchLines();
    beginPan({target: container, clientX: 50, clientY: 500});
    movePan({clientX: 130, clientY: 560}); await twoFrames(); stopPan();
    check(panX === 80 && panY === 60, 'Background panning commits movement');
    check(lineMutations.length === 0, 'Panning does not update connectors'); lineWatcher.disconnect();
  })()`);
  console.log('PASS cycle prevention and panning without connector updates');

  await command('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await evaluate(`resetMap(); interactionMode = 'move'; updateModeUI();`);
  const button = await evaluate(`(() => { const r = document.getElementById('add-child-btn').getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [button] });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await evaluate(`new Promise(resolve => setTimeout(resolve, 350))`);
  await evaluate(`check(nodesData.length === 2 && lastNode().parentId === centralNodeId, 'Touch button adds child'); assertVisible(lastNode().id);`);
  console.log('PASS iPad portrait touch adds a visible connected node');

  const touchDrag = await evaluate(`(() => {
    const node = lastNode(); const rect = document.getElementById(node.id).getBoundingClientRect();
    return {id: node.id, x: rect.left + 30, y: rect.top + 20, beforeX: node.x, beforeY: node.y};
  })()`);
  await command('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:touchDrag.x, y:touchDrag.y}]});
  await command('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:touchDrag.x - 90, y:touchDrag.y + 120}]});
  await evaluate('twoFrames()');
  await evaluate(`check(dragSession?.moved && !isPanning, 'Touch drags node without panning'); check(getComputedStyle(dragSession.element).filter === 'none', 'Touch drag keeps text sharp');`);
  await command('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
  const touchPosition = await evaluate(`({x:nodesById.get('${touchDrag.id}').x, y:nodesById.get('${touchDrag.id}').y, active:!!dragSession})`);
  assert.equal(touchPosition.x, touchDrag.beforeX - 90);
  assert.equal(touchPosition.y, touchDrag.beforeY + 120);
  assert.equal(touchPosition.active, false);
  console.log('PASS real touch dragging commits final position without panning');

  const cancelTouch = await evaluate(`(() => {const r=nodeElements.get('${touchDrag.id}').getBoundingClientRect(); return {x:r.left+30,y:r.top+20};})()`);
  await command('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[cancelTouch]});
  await command('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:cancelTouch.x+70,y:cancelTouch.y+80}]});
  await evaluate('twoFrames()');
  await command('Input.dispatchTouchEvent', {type:'touchCancel', touchPoints:[]});
  const cancelledPosition = await evaluate(`({x:nodesById.get('${touchDrag.id}').x, y:nodesById.get('${touchDrag.id}').y, active:!!dragSession})`);
  assert.deepEqual(cancelledPosition, touchPosition);
  console.log('PASS touch cancellation restores position and releases capture');

  await command('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate(`
    const element = nodeElements.get('${touchDrag.id}'); element.classList.add('dragging');
    check(getComputedStyle(element).transitionDuration === '0s', 'Reduced motion removes transitions');
    check(getComputedStyle(element, '::before').backdropFilter === 'none', 'Reduced motion disables halo blur');
    element.classList.remove('dragging');
  `);
  await command('Emulation.setEmulatedMedia', {features:[]});
  console.log('PASS reduced-motion styling');

  await evaluate(`interactionMode = 'edit'; updateModeUI(); focusNode(lastNode().id); document.getElementById(lastNode().id).textContent = 'Keep typing'; updateNodeText(lastNode().id);`);
  const focusedId = await evaluate('document.activeElement.id');
  await command('Emulation.setDeviceMetricsOverride', { width: 820, height: 540, deviceScaleFactor: 2, mobile: true });
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate('document.activeElement.id'), focusedId, 'Resize preserves editor focus');
  await evaluate('assertVisible(lastNode().id)');
  console.log('PASS reduced viewport preserves editor focus and keeps node visible');

  // Leave a readable example in the browser for visual inspection.
  await command('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
  await evaluate(`
    resetMap(); nodesData[0].text = 'Project ideas'; renderMindMap();
    for (const label of ['Explore', 'Create', 'Share', 'Reflect']) {
      addNode(centralNodeId); const branch = lastNode(); branch.text = label; renderMindMap();
      for (const text of ['First steps', 'Useful resources']) {
        addNode(branch.id); lastNode().text = text; renderMindMap();
      }
    }
    panX = 0; panY = 0; updateCanvasTransform();
  `);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('/tmp/mindmap-placement.png', Buffer.from(screenshot.data, 'base64'));

  // Verify the mouse/touch fallback for browsers without Pointer Events.
  const fallbackScript = await command('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(window, 'PointerEvent', {value: undefined, configurable: true});"
  });
  await command('Emulation.setDeviceMetricsOverride', {width:820,height:1180,deviceScaleFactor:2,mobile:true});
  await command('Page.reload', {ignoreCache:true});
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("typeof isInitialized !== 'undefined' && isInitialized && !window.PointerEvent")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate('!window.PointerEvent'), true);
  await evaluate(`
    urlStorageEnabled = false;
    nodesData = [
      {id:centralNodeId,parentId:null,x:100,y:300,text:'Fallback',color:'#FFFFFF'},
      {id:'touch-fallback',parentId:centralNodeId,x:400,y:300,text:'Drag me',color:'#FFFFFF'}
    ];
    interactionMode = 'move'; renderMindMap();
  `);
  await command('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:430,y:320}]});
  await command('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:490,y:420}]});
  await command('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
  await evaluate('new Promise(resolve => setTimeout(resolve, 350))');
  const fallback = await evaluate(`({x:nodesById.get('touch-fallback').x,y:nodesById.get('touch-fallback').y,active:!!dragSession})`);
  assert.deepEqual(fallback, {x:460,y:400,active:false});
  await command('Page.removeScriptToEvaluateOnNewDocument', {identifier:fallbackScript.identifier});
  await command('Page.reload', {ignoreCache:true});
  console.log('PASS touch fallback without Pointer Events or duplicate mouse gestures');
  assert.equal(errors.length, 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  console.log('PASS no browser exceptions; screenshot: /tmp/mindmap-placement.png');
} finally {
  socket.close();
}
