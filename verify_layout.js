const nodes = [
    { "id": "central-node", "parentId": null, "x": 0, "y": 0, "color": "#FFFFFF", "text": "Test 1" },
    { "id": "node-1375mhqyg", "parentId": "central-node", "color": "#FFFFFF", "text": "First idea", "x": 0, "y": 0 },
    { "id": "node-9h81j6jeo", "parentId": "node-1375mhqyg", "color": "#FFFFFF", "text": "Another idea", "x": 0, "y": 0 },
    { "id": "node-2lb8v576p", "parentId": "central-node", "color": "#FFFFFF", "text": "Second idea", "x": 0, "y": 0 },
    { "id": "node-gugzbs1n4", "parentId": "node-2lb8v576p", "color": "#FFFFFF", "text": "Second plan", "x": 0, "y": 0 }
];

function getNodeDepth(node, nodes, depth = 0) {
    if (node.parentId === null) {
        return depth;
    }
    const parent = nodes.find(n => n.id === node.parentId);
    if (!parent) return depth;
    return getNodeDepth(parent, nodes, depth + 1);
}

function positionNodes(nodes) {
    console.log('=== positionNodes called with', nodes.length, 'nodes ===');

    const centralNode = nodes.find(n => n.id === 'central-node');
    if (!centralNode) {
        console.error('Central node not found.');
        return;
    }

    // Start with central node at origin
    centralNode.x = 0;
    centralNode.y = 0;

    // Group nodes by depth level
    const nodesByDepth = {};
    nodes.forEach(node => {
        const depth = getNodeDepth(node, nodes);
        if (!nodesByDepth[depth]) {
            nodesByDepth[depth] = [];
        }
        nodesByDepth[depth].push(node);
    });

    console.log('Nodes by depth:', Object.keys(nodesByDepth).map(d => `Depth ${d}: ${nodesByDepth[d].length} nodes`));

    // Just checking depths for verification
    nodes.forEach(n => {
        console.log(`Node ${n.text} (${n.id}) Depth: ${getNodeDepth(n, nodes)}`);
    });
}

positionNodes(nodes);
