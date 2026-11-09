import { parse } from "./parser.js";
import { analyze } from "./semantic-analyzer.js";
import { lowerToQIR, serializeQIR, validateQIR } from "./qir.js";
import { COMBINING_CLASS, UNICODE_VERSION } from "./unicode-data.js";
import { getUIComponentRegistry, validateUIComponentTree } from "./ui-component-runtime.js";

export class QXWebBuildError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message); this.name = "QXWebBuildError"; this.code = code; this.diagnostics = diagnostics;
  }
}
const LIMITS = Object.freeze({ maxInstructions: 100000, maxCallDepth: 128, maxListLength: 10000, maxStringLength: 1000000 });
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[ch]);
}
function browserRun(module, combiningClassEntries, uiLock, uiRegistry) {
  const LIMITS = Object.freeze({ maxInstructions: 100000, maxCallDepth: 128, maxListLength: 10000, maxStringLength: 1000000 });
  const UNINITIALIZED = Symbol("QX_UNINITIALIZED");
  const clone = value => Array.isArray(value) ? value.map(clone) : value;
  const combiningClasses = new Map(combiningClassEntries);
  const normalize = value => {
    if (typeof value !== "string") throw new TypeError("NFC input must be a string");
    const points = Array.from(value.normalize("NFD"), c => c.codePointAt(0));
    for (let i = 1; i < points.length; i++) {
      const current = combiningClasses.get(points[i]) ?? 0;
      if (current === 0) continue;
      let j = i;
      while (j > 0) {
        const previous = combiningClasses.get(points[j - 1]) ?? 0;
        if (previous === 0 || previous <= current) break;
        [points[j - 1], points[j]] = [points[j], points[j - 1]];
        j--;
      }
    }
    let ordered = "";
    for (let i = 0; i < points.length; i += 8192) ordered += String.fromCodePoint(...points.slice(i, i + 8192));
    return ordered.normalize("NFC");
  };
  function compareText(a,b) {
    const x=Array.from(normalize(a),c=>c.codePointAt(0)), y=Array.from(normalize(b),c=>c.codePointAt(0));
    for(let i=0;i<Math.min(x.length,y.length);i++) if(x[i]!==y[i]) return x[i]<y[i]?-1:1;
    return x.length===y.length?0:x.length<y.length?-1:1;
  }
  function fail(code,message,inst,ctx) {
    const e=new Error(message); e.code=code; e.location=inst&&inst.source||null; e.context=ctx||{}; throw e;
  }
  const globalsById=new Map(module.globals.map(x=>[x.id,x]));
  const globals=new Map(module.globals.map(x=>[x.id,UNINITIALIZED]));
  const functions=new Map([module.initializer,...module.functions].map(x=>[x.id,x]));
  let instructionCount=0;
  const outputs=[];
  function validateUITree(treeJson, inst, ctx) {
    if (new TextEncoder().encode(treeJson).length > 65536) fail("QX_UI_TREE_INVALID", "UI component tree exceeds the byte limit", inst, ctx);
    let tree;
    try { tree = JSON.parse(treeJson); }
    catch { fail("QX_UI_TREE_INVALID", "UI component tree must be valid JSON", inst, ctx); }
    const registry = new Map((uiRegistry || []).map(entry => [entry.type, entry]));
    if (!uiLock || Object.getPrototypeOf(uiLock) !== Object.prototype || Object.keys(uiLock).sort().join(",") !== "components,schema,version" || uiLock.schema !== "QX.UI.COMPONENT-LOCK" || uiLock.version !== "1.0" || !Array.isArray(uiLock.components))
      fail("QX_UI_LOCK_INVALID", "Invalid UI component lock", inst, ctx);
    const pins = new Map();
    let previousType = null, previousVersion = null;
    for (const entry of uiLock.components) {
      if (!entry || Object.keys(entry).sort().join(",") !== "contractVersion,registryRelease,schemaDigest,type" ||
          typeof entry.type !== "string" || typeof entry.contractVersion !== "string" ||
          typeof entry.schemaDigest !== "string" || typeof entry.registryRelease !== "string")
        fail("QX_UI_LOCK_INVALID", "Invalid UI component lock entry", inst, ctx);
      if (previousType !== null && (entry.type < previousType || (entry.type === previousType && entry.contractVersion < previousVersion)))
        fail("QX_UI_LOCK_ORDER", "UI lock entries are not sorted", inst, ctx);
      previousType = entry.type; previousVersion = entry.contractVersion;
      const key = entry.type + "@" + entry.contractVersion;
      if (pins.has(key)) fail("QX_UI_LOCK_DUPLICATE", "Duplicate UI lock entry", inst, ctx);
      const registered = registry.get(entry.type);
      if (!registered) fail("QX_UI_UNKNOWN_COMPONENT", "Unknown UI component in lock", inst, ctx);
      if (entry.contractVersion !== registered.contractVersion || entry.registryRelease !== registered.registryRelease)
        fail("QX_UI_RELEASE_UNAVAILABLE", "Exact UI component release is unavailable", inst, ctx);
      if (entry.schemaDigest !== registered.schemaDigest)
        fail("QX_UI_DIGEST_MISMATCH", "UI component schema digest mismatch", inst, ctx);
      pins.set(key, entry);
    }
    if (!tree || Object.getPrototypeOf(tree) !== Object.prototype ||
        Object.keys(tree).sort().join(",") !== "children,schema,version" ||
        tree.schema !== "QX.UI.TREE" || tree.version !== "1.0" || !Array.isArray(tree.children))
      fail("QX_UI_TREE_INVALID", "Invalid UI component tree envelope", inst, ctx);
    const ids = new Set(); let count = 0, totalText = 0;
    function visit(node, depth, policy) {
      if (depth > 32) fail("QX_UI_TREE_DEPTH", "UI tree nesting limit exceeded", inst, ctx);
      if (++count > 1000) fail("QX_UI_TREE_NODES", "UI tree node limit exceeded", inst, ctx);
      if (!node || Object.getPrototypeOf(node) !== Object.prototype) fail("QX_UI_NODE_INVALID", "Invalid UI tree node", inst, ctx);
      if (node.kind === "text") {
        if (Object.keys(node).sort().join(",") !== "kind,value" || typeof node.value !== "string")
          fail("QX_UI_TEXT_INVALID", "Invalid UI text node", inst, ctx);
        if (policy && !policy.text) fail("QX_UI_CHILD_POLICY", "Text children are not permitted", inst, ctx);
        if (node.value.length > 10000 || (totalText += node.value.length) > 50000)
          fail("QX_UI_TEXT_LIMIT", "UI text limit exceeded", inst, ctx);
        return { kind: "text", value: node.value };
      }
      if (node.kind !== "component" || Object.keys(node).sort().join(",") !== "children,id,kind,props,type,version")
        fail("QX_UI_NODE_INVALID", "Invalid UI component node", inst, ctx);
      if (typeof node.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(node.id))
        fail("QX_UI_ID_INVALID", "Invalid UI component ID", inst, ctx);
      if (ids.has(node.id)) fail("QX_UI_ID_DUPLICATE", "Duplicate UI component ID", inst, ctx);
      ids.add(node.id);
      if (policy && !policy.components.includes(node.type)) fail("QX_UI_CHILD_POLICY", "Component child is not permitted", inst, ctx);
      const definition = registry.get(node.type);
      if (!definition) fail("QX_UI_UNKNOWN_COMPONENT", "Unknown UI component type", inst, ctx);
      if (node.version !== definition.contractVersion) fail("QX_UI_VERSION_MISMATCH", "UI component version mismatch", inst, ctx);
      if (!pins.has(node.type + "@" + node.version)) fail("QX_UI_LOCK_MISSING", "Missing exact UI component lock pin", inst, ctx);
      if (!node.props || Object.getPrototypeOf(node.props) !== Object.prototype ||
          Object.keys(node.props).some(key => !Object.hasOwn(definition.props, key)) || Object.keys(node.props).length > 16)
        fail("QX_UI_PROPS_INVALID", "Invalid UI component properties", inst, ctx);
      if (new TextEncoder().encode(JSON.stringify(node.props)).length > 4096) fail("QX_UI_PROP_LIMIT", "UI component properties exceed the byte limit", inst, ctx);
      for (const [name, rule] of Object.entries(definition.props)) {
        const value = node.props[name];
        if (rule.required && value === undefined) fail("QX_UI_PROP_REQUIRED", "Missing UI component property", inst, ctx);
        if (value !== undefined && (typeof value !== rule.type || (rule.integer && !Number.isSafeInteger(value)) ||
            (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)))
          fail("QX_UI_PROP_INVALID", "Invalid UI component property", inst, ctx);
      }
      if (!Array.isArray(node.children)) fail("QX_UI_CHILDREN_INVALID", "UI component children must be an array", inst, ctx);
      return { kind: "component", id: node.id, type: node.type, version: node.version,
        props: { ...node.props }, children: node.children.map(child => visit(child, depth + 1, definition.children)) };
    }
    return { schema: "QX.UI.TREE", version: "1.0", children: tree.children.map(node => visit(node, 1, null)) };
  }
  function binary(op,a,b,inst,ctx) {
    const num=v=>{if(typeof v!=="number"||!Number.isFinite(v))fail("QX_VM_INVALID_NUMBER","Expected finite NUM",inst,ctx);return v;};
    const str=v=>{if(typeof v!=="string"||v.length>LIMITS.maxStringLength)fail("QX_VM_INVALID_TEXT","Expected bounded TXT",inst,ctx);return v;};
    switch(op) {
      case "+": return typeof a==="string"&&typeof b==="string"?str(a+b):num(num(a)+num(b));
      case "-": return num(num(a)-num(b));
      case "*": return num(num(a)*num(b));
      case "/": if(num(b)===0)fail("QX_VM_DIVIDE_BY_ZERO","Division by zero",inst,ctx); return num(num(a)/b);
      case "%": if(!Number.isInteger(num(a))||!Number.isInteger(num(b)))fail("QX_VM_REMAINDER_INTEGER","Remainder requires integers",inst,ctx); if(b===0)fail("QX_VM_DIVIDE_BY_ZERO","Remainder by zero",inst,ctx); return a%b;
      case "==": case "!=":
        if(Array.isArray(a)||Array.isArray(b))fail("QX_VM_LIST_EQUALITY_UNSPECIFIED","LIST equality is not defined in QIR V1",inst,ctx);
        {const eq=typeof a==="string"&&typeof b==="string"?normalize(a)===normalize(b):a===b;return op==="=="?eq:!eq;}
      case ">": case ">=": case "<": case "<=": {
        let c;
        if(typeof a==="number"&&typeof b==="number"){num(a);num(b);c=a<b?-1:a>b?1:0;}
        else if(typeof a==="string"&&typeof b==="string"){str(a);str(b);c=compareText(a,b);}
        else fail("QX_VM_INVALID_COMPARISON","Expected matching NUM or TXT",inst,ctx);
        return op===">"?c>0:op===">="?c>=0:op==="<"?c<0:c<=0;
      }
      case "AND": return a===true&&b===true;
      case "OR": return a===true||b===true;
      default: fail("QX_VM_UNKNOWN_OPERATOR","Unsupported operator: "+op,inst,ctx);
    }
  }
  function execute(fn,args,depth) {
    if(depth>LIMITS.maxCallDepth)fail("QX_VM_CALL_DEPTH_LIMIT","Maximum call depth exceeded",null,{function:fn.id});
    const blocks=new Map(fn.blocks.map(x=>[x.id,x])), vars=new Map(), values=new Map(), ctx={function:fn.id,block:null};
    const params=fn.blocks.flatMap(b=>b.instructions).filter(i=>i.opcode==="DECLARE"&&i.operands.parameter===true);
    if(params.length!==fn.parameters.length||args.length!==fn.parameters.length)fail("QX_VM_PARAMETER_MISMATCH","Function parameter mismatch",null,ctx);
    params.forEach((i,n)=>vars.set(i.operands.variable,clone(args[n])));
    const read=(id,i)=>{if(!values.has(id))fail("QX_VM_UNDEFINED_VALUE","Unavailable value: "+id,i,ctx);return values.get(id);};
    const readVar=(id,i)=>{const v=globalsById.has(id)?globals.get(id):vars.get(id);if(v===undefined||v===UNINITIALIZED)fail("QX_VM_UNINITIALIZED_VARIABLE","Uninitialized variable: "+id,i,ctx);return v;};
    const write=(id,v,i,g)=>{if(g){if(!globalsById.has(id))fail("QX_VM_UNKNOWN_GLOBAL","Unknown global: "+id,i,ctx);globals.set(id,clone(v));}else{if(!vars.has(id))fail("QX_VM_UNKNOWN_LOCAL","Unknown local: "+id,i,ctx);vars.set(id,clone(v));}};
    let blockId=fn.entry_block;
    while(true) {
      const block=blocks.get(blockId);if(!block)fail("QX_VM_INVALID_BLOCK","Unknown block: "+blockId,null,ctx);ctx.block=block.id;
      let transferred=false;
      for(const i of block.instructions) {
        if(++instructionCount>LIMITS.maxInstructions)fail("QX_VM_INSTRUCTION_LIMIT","Instruction budget exceeded",i,ctx);
        const o=i.operands||{};
        switch(i.opcode) {
          case "CONST_NUM": if(typeof o.value!=="number"||!Number.isFinite(o.value))fail("QX_VM_INVALID_NUMBER","Invalid number",i,ctx);values.set(i.result,o.value);break;
          case "CONST_TXT": if(typeof o.value!=="string"||o.value.length>LIMITS.maxStringLength)fail("QX_VM_INVALID_TEXT","Invalid text",i,ctx);values.set(i.result,o.value);break;
          case "CONST_BOOL": values.set(i.result,o.value);break;
          case "CONST_NULL": values.set(i.result,null);break;
          case "DECLARE": if(o.storage==="global"){if(!globalsById.has(o.variable))fail("QX_VM_UNKNOWN_GLOBAL","Unknown global",i,ctx);globals.set(o.variable,UNINITIALIZED);}else if(o.parameter!==true)vars.set(o.variable,UNINITIALIZED);break;
          case "LOAD": values.set(i.result,readVar(o.variable,i));break;
          case "STORE_LOCAL": write(o.variable,read(o.value,i),i,false);break;
          case "STORE_GLOBAL": write(o.variable,read(o.value,i),i,true);break;
          case "UNARY": {const v=read(o.value,i);let r;if(o.operator==="NOT")r=!v;else if((o.operator==="+"||o.operator==="-")&&typeof v==="number"&&Number.isFinite(v))r=o.operator==="+"?v:-v;else fail("QX_VM_UNKNOWN_OPERATOR","Invalid unary operation",i,ctx);values.set(i.result,r);break;}
          case "BINARY": values.set(i.result,binary(o.operator,read(o.left,i),read(o.right,i),i,ctx));break;
          case "MAKE_LIST": if(o.elements.length>LIMITS.maxListLength)fail("QX_VM_LIST_LIMIT","List limit exceeded",i,ctx);values.set(i.result,o.elements.map(id=>clone(read(id,i))));break;
          case "CALL": {const target=functions.get(o.function);if(!target)fail("QX_VM_UNKNOWN_FUNCTION","Unknown function",i,ctx);const r=execute(target,o.arguments.map(id=>clone(read(id,i))),depth+1);if(i.result)values.set(i.result,r);break;}
          case "COMMAND_CALL": {
            const args=o.arguments||[];
            if(o.command==="DATA.COUNT"&&args.length===1){const list=read(args[0],i);if(!Array.isArray(list))fail("QX_VM_COMMAND_ARGUMENT","DATA.COUNT requires LIST",i,ctx);if(i.result)values.set(i.result,list.length);break;}
            if(o.command==="DATA.ADD"&&args.length===2){const list=read(args[0],i),value=read(args[1],i);if(!Array.isArray(list))fail("QX_VM_COMMAND_ARGUMENT","DATA.ADD requires LIST",i,ctx);if(list.length>=LIMITS.maxListLength)fail("QX_VM_LIST_LIMIT","Maximum list length exceeded",i,ctx);values.set(i.result,[...list.map(clone),clone(value)]);break;}
            if(o.command==="DATA.REMOVE"&&args.length===2){const list=read(args[0],i),index=read(args[1],i);if(!Array.isArray(list))fail("QX_VM_COMMAND_ARGUMENT","DATA.REMOVE requires LIST",i,ctx);if(!Number.isSafeInteger(index)||index<0||index>=list.length)fail("QX_VM_LIST_INDEX","DATA.REMOVE index must be a valid zero-based integer within the list",i,ctx);values.set(i.result,list.filter((_,n)=>n!==index).map(clone));break;}
            if(o.command==="UI.TREE"&&args.length===1&&module.version==="1.4"){
              const json=read(args[0],i);
              if(typeof json!=="string"||json.length>LIMITS.maxStringLength)fail("QX_VM_INVALID_TEXT","UI.TREE requires bounded TXT JSON",i,ctx);
              outputs.push({component:"TREE",tree:validateUITree(json,i,ctx),source:i.source});break;
            }
            if(o.command==="UI.SHOW"&&args.length===1&&["1.2","1.3","1.4"].includes(module.version)){outputs.push({component:"SHOW",value:clone(read(args[0],i)),source:i.source});break;}
            if(o.command==="UI.TEXT"&&args.length===1&&["1.2","1.3","1.4"].includes(module.version)){const value=read(args[0],i);if(typeof value!=="string"||value.length>LIMITS.maxStringLength)fail("QX_VM_INVALID_TEXT","UI.TEXT requires bounded TXT",i,ctx);outputs.push({component:"TEXT",value,source:i.source});break;}
            fail("QX_VM_COMMAND_NOT_ALLOWED","Command is not available in this QIR version",i,ctx);break;
          }
          case "BRANCH": {const v=read(o.condition,i);if(typeof v!=="boolean")fail("QX_VM_BRANCH_TYPE","BRANCH requires BOOL",i,ctx);blockId=v?o.true_target:o.false_target;transferred=true;break;}
          case "JUMP": blockId=o.target;transferred=true;break;
          case "RETURN": return Object.hasOwn(o,"value")?clone(read(o.value,i)):null;
          default: fail("QX_VM_UNKNOWN_OPCODE","Unsupported opcode: "+i.opcode,i,ctx);
        }
        if(transferred)break;
      }
      if(!transferred)fail("QX_VM_MISSING_TERMINATOR","Block missing terminator",null,ctx);
    }
  }
  execute(module.initializer,[],1);
  const result={};
  for(const item of module.globals){const v=globals.get(item.id);if(v!==UNINITIALIZED)result[item.name]=clone(v);}
  return {globals:result,outputs,instructionCount};
}
function browserEntry(module, runProgram, combiningClassEntries, uiLock, uiRegistry) {
const root=document.getElementById("qx-output");
const status=document.getElementById("qx-status");
const runButton=document.getElementById("qx-run-button");
function run() {
  if(typeof root.replaceChildren==="function")root.replaceChildren();
  else if(Array.isArray(root.children))root.children.length=0;
  status.textContent="Running QX program…";
  try {
    const result=runProgram(module, combiningClassEntries, uiLock, uiRegistry);
    status.textContent="Execution completed";
    for(const item of result.outputs||[]){
      if(item.component==="TEXT"){
        const text=document.createElement("p");text.className="qx-ui-text";text.textContent=item.value;root.append(text);
      }else if(item.component==="TREE"){
        const registry=new Map((uiRegistry||[]).map(entry=>[entry.type,entry]));
        const renderNode=node=>{
          if(node.kind==="text")return document.createTextNode(node.value);
          const definition=registry.get(node.type);
          let element;
          if(definition.renderer==="container"){element=document.createElement("div");element.className="qx-ui-container";}
          else if(definition.renderer==="text-block"){element=document.createElement("p");element.className="qx-ui-text-block";}
          else if(definition.renderer==="heading"){element=document.createElement("h"+node.props.level);element.className="qx-ui-heading";}
          else throw new Error("Unsupported host UI renderer");
          for(const child of node.children)element.append(renderNode(child));
          return element;
        };
        for(const child of item.tree.children)root.append(renderNode(child));
      }else if(item.component==="SHOW"){
        const section=document.createElement("section");section.className="qx-ui-show";
        const pre=document.createElement("pre");pre.textContent=typeof item.value==="string"?item.value:JSON.stringify(item.value,null,2);
        section.append(pre);root.append(section);
      }
    }
    const entries=Object.entries(result.globals);
    if(!entries.length&&!(result.outputs||[]).length){const p=document.createElement("p");p.textContent="Program completed. No UI output or global values were produced.";root.append(p);}
    for(const [name,value] of entries){
      const section=document.createElement("section");section.className="qx-value";
      const h=document.createElement("h2");h.textContent=name;
      const pre=document.createElement("pre");pre.textContent=JSON.stringify(value,null,2);
      section.append(h,pre);root.append(section);
    }
    const meta=document.createElement("p");meta.className="qx-meta";meta.textContent=result.instructionCount+" instructions executed";root.append(meta);
  } catch(error) {
    status.textContent="Execution failed";
    const detail=document.createElement("pre");detail.className="qx-error";
    detail.textContent=(error.code||"QX_RUNTIME_ERROR")+": "+error.message+(error.location?" (line "+error.location.line+", column "+error.location.column+")":"");
    root.append(detail);
  }
}
if(runButton){
  status.textContent="Ready to run";
  runButton.addEventListener("click",run);
}else{
  run();
}
}
export function generateWebAssets(qir, options = {}) {
  const diagnostics=validateQIR(qir);
  if(diagnostics.length)throw new QXWebBuildError("QX_WEB_INVALID_QIR","Cannot build invalid QIR",diagnostics);
  const hasUITree=[qir.initializer,...qir.functions].some(fn=>
    fn.blocks.some(block=>block.instructions.some(inst=>inst.opcode==="COMMAND_CALL"&&inst.operands?.command==="UI.TREE")));
  let uiLock=null, uiRegistry=[];
  if(hasUITree){
    if(!options.uiLock)throw new QXWebBuildError("QX_WEB_UI_LOCK_REQUIRED","UI.TREE requires the project's qx.ui-lock.json manifest");
    try{
      validateUIComponentTree({schema:"QX.UI.TREE",version:"1.0",children:[]},options.uiLock);
      uiLock=typeof options.uiLock==="string"?JSON.parse(options.uiLock):options.uiLock;
      uiRegistry=getUIComponentRegistry();
    }catch(error){
      throw new QXWebBuildError("QX_WEB_UI_LOCK_INVALID","UI component lock validation failed", [{ code: error.code || "QX_UI_LOCK_INVALID", message: "The supplied UI lock does not match the host registry" }]);
    }
  }
  const hasIntegrationRequest=[qir.initializer,...qir.functions].some(fn=>
    fn.blocks.some(block=>block.instructions.some(inst=>inst.opcode==="COMMAND_CALL"&&inst.operands?.command==="INTEGRATION.REQUEST")));
  if(hasIntegrationRequest)throw new QXWebBuildError("QX_WEB_INTEGRATION_UNSUPPORTED","INTEGRATION.REQUEST requires a trusted host runtime and is not available in static browser builds");
  const title=typeof options.title==="string"&&options.title.trim()?options.title.trim():"QX Web Project";
  if(title.length>120)throw new QXWebBuildError("QX_WEB_INVALID_TITLE","Project title must be 120 characters or fewer");
  const json=serializeQIR(qir).replace(/</g,"\\u003c");
  const appJS="const module = "+json+";\nconst combiningClasses = "+JSON.stringify([...COMBINING_CLASS.entries()])+";\nconst uiLock = "+JSON.stringify(uiLock)+";\nconst uiRegistry = "+JSON.stringify(uiRegistry)+";\n("+browserEntry.toString()+")(module, ("+browserRun.toString()+"), combiningClasses, uiLock, uiRegistry);\n";
  const html=[
    "<!doctype html>","<html lang=\"en\"><head>","<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'\">",
    "<title>"+escapeHTML(title)+"</title>","<link rel=\"stylesheet\" href=\"./styles.css\">",
    "<script defer src=\"./app.js\"></script>","</head><body><main class=\"qx-shell\">",
    "<header class=\"qx-header\"><p class=\"qx-eyebrow\">ALI-QX · WEB BACKEND</p><h1>"+escapeHTML(title)+"</h1>",
    "<p>Generated from a validated QIR module.</p><p id=\"qx-status\" class=\"qx-status\" role=\"status\" aria-live=\"polite\">Ready to run</p>",
    "<button id=\"qx-run-button\" class=\"qx-run-button\" type=\"button\">Run QX program</button></header>",
    "<div id=\"qx-output\" class=\"qx-output\" aria-live=\"polite\"></div>",
    "<footer>QX V1 · Local execution · No network integrations</footer></main></body></html>"
  ].join("\n");
  const css=[
    ":root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f3f5f8; color: #172033; }",
    "* { box-sizing: border-box; } body { margin: 0; min-height: 100vh; }",
    ".qx-shell { width: min(880px, calc(100% - 32px)); margin: 48px auto; }",
    ".qx-header, .qx-value { background: #fff; border: 1px solid #e2e7ef; border-radius: 18px; padding: 24px; box-shadow: 0 8px 30px rgb(23 32 51 / 5%); }",
    ".qx-eyebrow, .qx-meta { color: #68758b; font-size: .78rem; letter-spacing: .08em; }",
    "h1 { margin: .25rem 0; font-size: clamp(1.8rem, 5vw, 2.6rem); } .qx-status { color: #176b46; font-weight: 650; } .qx-run-button { margin-top: 8px; padding: 11px 18px; border: 0; border-radius: 10px; background: #2457c5; color: #fff; font: inherit; font-weight: 650; cursor: pointer; } .qx-run-button:focus-visible { outline: 3px solid #91b4ff; outline-offset: 3px; } .qx-run-button:hover { background: #1946a8; }",
    ".qx-output { display: grid; gap: 14px; margin-top: 18px; } .qx-ui-container { display: grid; gap: 12px; padding: 18px; border: 1px solid #e2e7ef; border-radius: 14px; background: #fff; } .qx-ui-text-block { margin: 0; line-height: 1.6; } .qx-ui-heading { margin: 0; } .qx-value h2 { margin: 0 0 12px; font-size: 1rem; } .qx-ui-text, .qx-ui-show { margin: 0; padding: 16px 18px; border: 1px solid #e2e7ef; border-radius: 12px; background: #fff; line-height: 1.6; overflow-wrap: anywhere; } .qx-ui-show pre { background: transparent; padding: 0; }",
    "pre { margin: 0; padding: 14px; border-radius: 10px; overflow: auto; background: #f5f7fa; white-space: pre-wrap; overflow-wrap: anywhere; }",
    ".qx-error { color: #9b2525; border: 1px solid #efcaca; background: #fff7f7; } footer { margin: 24px 4px; color: #758198; font-size: .8rem; }",
    "@media (max-width: 520px) { .qx-shell { margin: 18px auto; } .qx-header, .qx-value { padding: 18px; } }"
  ].join("\n");
  return Object.freeze({format:"QX_WEB_PROJECT_V1",files:Object.freeze({"index.html":html,"styles.css":css,"app.js":appJS}),
    metadata:Object.freeze({qirVersion:qir.version,unicodeVersion:UNICODE_VERSION,runtime:"browser-qir-compatible",networkAccess:false})});
}
export function buildWebProject(source, options = {}) {
  if(typeof source!=="string")throw new TypeError("QX source must be a string");
  let ast;
  try{ast=parse(source);}catch(error){throw new QXWebBuildError(error.code||"QX_WEB_PARSE_ERROR",error.message,error.location?[{code:error.code,message:error.message,location:error.location}]:[]);}
  const semantic=analyze(ast);
  if(!semantic.valid)throw new QXWebBuildError("QX_WEB_SEMANTIC_ERROR","QX source contains semantic errors",semantic.diagnostics);
  const qir=lowerToQIR(ast,semantic);
  const diagnostics=validateQIR(qir);
  if(diagnostics.length)throw new QXWebBuildError("QX_WEB_INVALID_QIR","Generated QIR failed validation",diagnostics);
  return generateWebAssets(qir,options);
}
