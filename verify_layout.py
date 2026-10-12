import json

nodes = [
  {"id":"central-node","parentId":None,"x":0,"y":0,"color":"#FFFFFF","text":"Test 1"},
  {"id":"node-1375mhqyg","parentId":"central-node","color":"#FFFFFF","text":"First idea","x":0,"y":0},
  {"id":"node-9h81j6jeo","parentId":"node-1375mhqyg","color":"#FFFFFF","text":"Another idea","x":0,"y":0},
  {"id":"node-2lb8v576p","parentId":"central-node","color":"#FFFFFF","text":"Second idea","x":0,"y":0},
  {"id":"node-gugzbs1n4","parentId":"node-2lb8v576p","color":"#FFFFFF","text":"Second plan","x":0,"y":0}
]

def get_node_depth(node, nodes, depth=0):
    if node['parentId'] is None:
        return depth
    
    parent = next((n for n in nodes if n['id'] == node['parentId']), None)
    if not parent:
        return depth
    return get_node_depth(parent, nodes, depth + 1)

print("Verifying Depths:")
for node in nodes:
    depth = get_node_depth(node, nodes)
    print(f"Node {node['text']} ({node['id']}) Depth: {depth}")

# Expected:
# Test 1: 0
# First idea: 1
# Another idea: 2
# Second idea: 1
# Second plan: 2
