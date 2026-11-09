// Central, declarative QX V1 command catalog.
// Names are registered here; no command is executable until its complete
// signature and semantic/runtime contract have been specified and approved.

const asciiUpper = value => value.replace(/[a-z]/g, ch => ch.toUpperCase());

export const COMMAND_DOMAINS = Object.freeze([
  Object.freeze({ id: "DATA", aliases: Object.freeze(["DATA", "البيانات"]) }),
  Object.freeze({ id: "UI", aliases: Object.freeze(["UI", "الواجهات"]) }),
  Object.freeze({ id: "PROCESS", aliases: Object.freeze(["PROCESS", "المعالجة"]) }),
  Object.freeze({ id: "INTEGRATION", aliases: Object.freeze(["INTEGRATION", "التكامل"]) }),
  Object.freeze({ id: "QX", aliases: Object.freeze(["QX", "المحرك"]), kind: "system" })
]);

const definitions = [
  ["DATA", "CREATE", "إنشاء"],
  ["DATA", "SET", "تعيين"],
  ["DATA", "SET_GLOBAL", "تعيين_عام"],
  ["DATA", "ADD", "إضافة"],
  ["DATA", "REMOVE", "إزالة"],
  ["DATA", "GET", "جلب"],
  ["DATA", "COUNT", "عدد"],
  ["UI", "SHOW", "عرض"],
  ["UI", "TEXT", "نص"],
  ["UI", "TREE", "شجرة"],
  ["PROCESS", "ADD", "إضافة"],
  ["PROCESS", "CALCULATE", "احسب"],
  ["PROCESS", "COMPARE", "قارن"],
  ["INTEGRATION", "REQUEST", "طلب"],
  ["QX", "RUN", "تشغيل"],
  ["QX", "BUILD", "بناء"],
  ["QX", "TEST", "اختبر"],
  ["QX", "STOP", "أوقف"]
];

export const COMMAND_REGISTRY = Object.freeze(definitions.map(([domain, name, arabicName]) =>
  Object.freeze({
    id: domain + "." + name,
    domain,
    name,
    aliases: Object.freeze([
      Object.freeze({ domain, command: name }),
      Object.freeze({ domain: COMMAND_DOMAINS.find(item => item.id === domain).aliases[1], command: arabicName })
    ]),
    signature: domain === "DATA" && name === "ADD"
      ? Object.freeze({ parameters: Object.freeze([{ name: "list", type: "LIST" }, { name: "value", types: Object.freeze(["NUM", "TXT", "BOOL", "LIST", "NULL"]) }]), result: Object.freeze({ kind: "value", type: "LIST" }) })
      : domain === "DATA" && name === "REMOVE"
        ? Object.freeze({ parameters: Object.freeze([{ name: "list", type: "LIST" }, { name: "index", type: "NUM", integer: true, minimum: 0 }]), result: Object.freeze({ kind: "value", type: "LIST" }) })
        : domain === "DATA" && name === "COUNT"
      ? Object.freeze({
          parameters: Object.freeze([{ name: "list", type: "LIST" }]),
          result: Object.freeze({ kind: "value", type: "NUM" })
        })
      : domain === "UI" && name === "SHOW"
        ? Object.freeze({
            parameters: Object.freeze([{ name: "value", types: Object.freeze(["NUM", "TXT", "BOOL", "LIST", "NULL"]) }]),
            result: Object.freeze({ kind: "effect", component: "SHOW" })
          })
        : domain === "UI" && name === "TEXT"
          ? Object.freeze({
              parameters: Object.freeze([{ name: "text", type: "TXT" }]),
              result: Object.freeze({ kind: "effect", component: "TEXT" })
            })
      : domain === "UI" && name === "TREE"
          ? Object.freeze({
              parameters: Object.freeze([{ name: "treeJson", type: "TXT" }]),
              result: Object.freeze({ kind: "effect", component: "TREE" })
            })
      : domain === "PROCESS" && name === "ADD"
        ? Object.freeze({
            parameters: Object.freeze([
              { name: "target", type: "Identifier", variableType: "NUM", mustBeDeclared: true },
              { name: "amount", type: "Expression", resultType: "NUM" }
            ]),
            result: Object.freeze({ kind: "stored", target: "target", type: "NUM" })
          })
        : domain === "PROCESS" && name === "CALCULATE"
        ? Object.freeze({
            parameters: Object.freeze([
              { name: "target", type: "Identifier", variableType: "NUM", mustBeDeclared: true },
              { name: "expression", type: "Expression", resultType: "NUM" }
            ]),
            result: Object.freeze({ kind: "stored", target: "target", type: "NUM" })
          })
        : domain === "PROCESS" && name === "COMPARE"
          ? Object.freeze({
              parameters: Object.freeze([
                { name: "target", type: "Identifier", variableType: "BOOL", mustBeDeclared: true },
                { name: "expression", type: "Expression", resultType: "BOOL" }
              ]),
              result: Object.freeze({ kind: "stored", target: "target", type: "BOOL" })
            })
          : domain === "INTEGRATION" && name === "REQUEST"
            ? Object.freeze({
                parameters: Object.freeze([
                  { name: "connector", type: "TXT" },
                  { name: "operation", type: "TXT" },
                  { name: "payloadJson", type: "TXT" }
                ]),
                result: Object.freeze({ kind: "value", type: "TXT", asynchronous: true })
              })
          : null,
    signatureStatus: (domain === "DATA" && ["ADD", "REMOVE", "COUNT"].includes(name)) ||
      (domain === "PROCESS" && (name === "ADD" || name === "CALCULATE" || name === "COMPARE")) ||
      (domain === "UI" && (name === "SHOW" || name === "TEXT" || name === "TREE")) ||
      (domain === "INTEGRATION" && name === "REQUEST")
      ? "specified"
      : "pending",
    enabled: (domain === "DATA" && ["ADD", "REMOVE", "COUNT"].includes(name)) ||
      (domain === "PROCESS" && (name === "ADD" || name === "CALCULATE" || name === "COMPARE")) ||
      (domain === "UI" && (name === "SHOW" || name === "TEXT" || name === "TREE")) ||
      (domain === "INTEGRATION" && name === "REQUEST")
  })
));

const domainAliases = new Map();
for (const domain of COMMAND_DOMAINS) {
  for (const alias of domain.aliases) {
    const key = /^[\x00-\x7F]+$/.test(alias) ? asciiUpper(alias) : alias;
    if (domainAliases.has(key)) throw new Error("Duplicate QX domain alias: " + alias);
    domainAliases.set(key, domain.id);
  }
}

const commandAliases = new Map();
for (const command of COMMAND_REGISTRY) {
  for (const alias of command.aliases) {
    const domainKey = /^[\x00-\x7F]+$/.test(alias.domain) ? asciiUpper(alias.domain) : alias.domain;
    const commandKey = /^[\x00-\x7F]+$/.test(alias.command) ? asciiUpper(alias.command) : alias.command;
    const key = domainKey + "." + commandKey;
    if (commandAliases.has(key)) throw new Error("Duplicate QX command alias: " + key);
    commandAliases.set(key, command);
  }
}

export function resolveCommand(domain, command) {
  if (typeof domain !== "string" || typeof command !== "string") return null;
  const domainKey = /^[\x00-\x7F]+$/.test(domain) ? asciiUpper(domain) : domain;
  const commandKey = /^[\x00-\x7F]+$/.test(command) ? asciiUpper(command) : command;
  const canonicalDomain = domainAliases.get(domainKey);
  if (!canonicalDomain) return null;
  const canonicalCommand = commandAliases.get(domainKey + "." + commandKey);
  if (!canonicalCommand || canonicalCommand.domain !== canonicalDomain) return null;
  return canonicalCommand;
}

export function isCommandEnabled(domain, command) {
  return resolveCommand(domain, command)?.enabled === true;
}
