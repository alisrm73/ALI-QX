import { parse } from "./parser.js";
import { analyze } from "./semantic-analyzer.js";
import { lowerToQIR, serializeQIR, validateQIR } from "./qir.js";

export class QXWebBuildError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message); this.name = "QXWebBuildError"; this.code = code; this.diagnostics = diagnostics;
  }
}
const LIMITS = Object.freeze({ maxInstructions: 100000, maxCallDepth: 128, maxListLength: 10000, maxStringLength: 1000000 });
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[ch]);
}
function browserRun(module) {
  const UNINITIALIZED = Symbol("QX_UNINITIALIZED");
  const clone = value => Array.isArray(value) ? value.map(clone) : value;
  const normalize = value => value.normalize("NFC");
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
          case "COMMAND_CALL": if(o.command!=="DATA.COUNT"||o.arguments.length!==1)fail("QX_VM_COMMAND_NOT_ALLOWED","Only DATA.COUNT is supported",i,ctx);{const list=read(o.arguments[0],i);if(!Array.isArray(list))fail("QX_VM_COMMAND_ARGUMENT","DATA.COUNT requires LIST",i,ctx);if(i.result)values.set(i.result,list.length);}break;
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
  return {globals:result,instructionCount};
}
const root=document.getElementById("qx-output");
const status=document.getElementById("qx-status");
try {
  const result=browserRun(module);
  status.textContent="Execution completed";
  const entries=Object.entries(result.globals);
  if(!entries.length){const p=document.createElement("p");p.textContent="Program completed. No global values were produced.";root.append(p);}
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
export function generateWebAssets(qir, options = {}) {
  const diagnostics=validateQIR(qir);
  if(diagnostics.length)throw new QXWebBuildError("QX_WEB_INVALID_QIR","Cannot build invalid QIR",diagnostics);
  const title=typeof options.title==="string"&&options.title.trim()?options.title.trim():"QX Web Project";
  if(title.length>120)throw new QXWebBuildError("QX_WEB_INVALID_TITLE","Project title must be 120 characters or fewer");
  const json=serializeQIR(qir).replace(/</g,"\\u003c");
  const appJS="const module = "+json+";\n("+browserRun.toString()+")(module);\n";
  const html=[
    "<!doctype html>","<html lang=\"en\"><head>","<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'\">",
    "<title>"+escapeHTML(title)+"</title>","<link rel=\"stylesheet\" href=\"./styles.css\">",
    "<script defer src=\"./app.js\"></script>","</head><body><main class=\"qx-shell\">",
    "<header class=\"qx-header\"><p class=\"qx-eyebrow\">ALI-QX · WEB BACKEND</p><h1>"+escapeHTML(title)+"</h1>",
    "<p>Generated from a validated QIR V1 module.</p><p id=\"qx-status\" class=\"qx-status\" role=\"status\" aria-live=\"polite\">Starting QX program…</p></header>",
    "<div id=\"qx-output\" class=\"qx-output\" aria-live=\"polite\"></div>",
    "<footer>QX V1 · Local execution · No network integrations</footer></main></body></html>"
  ].join("\n");
  const css=[
    ":root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f3f5f8; color: #172033; }",
    "* { box-sizing: border-box; } body { margin: 0; min-height: 100vh; }",
    ".qx-shell { width: min(880px, calc(100% - 32px)); margin: 48px auto; }",
    ".qx-header, .qx-value { background: #fff; border: 1px solid #e2e7ef; border-radius: 18px; padding: 24px; box-shadow: 0 8px 30px rgb(23 32 51 / 5%); }",
    ".qx-eyebrow, .qx-meta { color: #68758b; font-size: .78rem; letter-spacing: .08em; }",
    "h1 { margin: .25rem 0; font-size: clamp(1.8rem, 5vw, 2.6rem); } .qx-status { color: #176b46; font-weight: 650; }",
    ".qx-output { display: grid; gap: 14px; margin-top: 18px; } .qx-value h2 { margin: 0 0 12px; font-size: 1rem; }",
    "pre { margin: 0; padding: 14px; border-radius: 10px; overflow: auto; background: #f5f7fa; white-space: pre-wrap; overflow-wrap: anywhere; }",
    ".qx-error { color: #9b2525; border: 1px solid #efcaca; background: #fff7f7; } footer { margin: 24px 4px; color: #758198; font-size: .8rem; }",
    "@media (max-width: 520px) { .qx-shell { margin: 18px auto; } .qx-header, .qx-value { padding: 18px; } }"
  ].join("\n");
  return Object.freeze({format:"QX_WEB_PROJECT_V1",files:Object.freeze({"index.html":html,"styles.css":css,"app.js":appJS}),
    metadata:Object.freeze({qirVersion:qir.version,unicodeVersion:qir.unicode_version,runtime:"browser-qir-v1",networkAccess:false})});
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
