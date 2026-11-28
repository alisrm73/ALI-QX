# مواصفة QIR V1
**QX Intermediate Representation — Versions 1.0–1.7**

- الحالة: المواصفة المعتمدة لـ QIR V1، والتنفيذ البرمجي متاح في `engine/qx-core/src/qir.js` مع اختبارات القبول في `engine/qx-core/test/qir.test.js`.
- النطاق: المرحلة الثالثة من ALI-QX.
- نطاق المصدر: صياغة QX Core V1 التنفيذية الحالية كما يحددها Lexer/Parser وسجل الأوامر. هذا لا يعني أن الأبجدية الهندسية المعتمدة في الدستور مدعومة في هذا الإصدار. مرجع Unicode: 18.0.0.
- الملفات المرجعية التي تمت مراجعتها: الدستور الهندسي للغة QX (مرجع الرموز فقط)، وengine/qx-core/src/lexer.js وparser.js وsemantic-analyzer.js وcommand-registry.js. مصفوفة التوافق: QX/spec/GEOMETRIC-LANGUAGE-ENGINE-COMPATIBILITY.md.

## 1. الهدف والحدود

QIR تمثيل وسيط موحد بين التحليل الدلالي ومراحل التنفيذ المستقبلية. يجب أن يحافظ على معنى QX V1 دون تغيير قواعد اللغة أو توسيع أوامرها وصلاحياتها.

تغطي هذه الوثيقة بنية الوحدة، المعرفات، الأنواع، عقود التعليمات، تحويل AST، تدفق التحكم، التحقق، التشخيص، JSON، Unicode واختبارات القبول. امتداد QIR 1.5 يضيف عقود الثبات وفرضها في QIR Validator وVM وWeb Backend. امتداد QIR 1.6 يضيف نوع RECORD وتعليمة MAKE_RECORD. امتداد QIR 1.7 يضيف تعليمة MAKE_UI_TREE لتمثيل أشجار واجهة ثابتة تحتوي مراجع قيم TXT ديناميكية، مع الحفاظ على ميزات الإصدارات السابقة.

المبادئ الملزمة:
1. لا تُحوّل وحدة قبل نجاح التحليل الدلالي.
2. لا تُمرر وحدة QIR غير صالحة إلى مرحلة لاحقة.
3. كل تعليمة تحتفظ بموضع المصدر الابتدائي المتاح؛ لا نخترع موضع نهاية غير موجود في AST.
4. لا نضيف أنواعاً أو تعليمات أو صلاحيات ضمن إصدار قائم؛ أي توسيع نوعي يتطلب امتداد QIR مرقماً ومواصفة واختبارات توافق. QIR 1.6 هو الامتداد المعتمد لنوع RECORD وتعليمة MAKE_RECORD، وQIR 1.7 هو الامتداد المعتمد لتعليمة MAKE_UI_TREE.
5. لا توجد PHI في V1؛ تستخدم متغيرات مؤقتة وتخزين صريح لدمج نتائج المسارات.
6. التحويل والتسلسل حتميان وقابلان لإعادة الإنتاج.
7. نجاح مواصفة QIR لا يعني تنفيذ VM أو Web Backend.

## 2. بنية Module

تتكون الوحدة من:
- Module: حاوية الوحدة والبيانات الوصفية.
- globals: تعريفات متغيرات الوحدة العامة.
- initializer: دالة داخلية تنفذ أوامر المستوى الأعلى بترتيب المصدر.
- functions: دوال QX المعرفة على المستوى الأعلى.
- Function: المعاملات، نوع الإرجاع، كتلة الدخول والكتل الأساسية.
- BasicBlock: تعليمات متتابعة مع نهاية تحكم صريحة.
- Instruction: عملية QIR.
- Value: نتيجة تعليمة.
- Operand: مرجع إلى قيمة أو متغير أو دالة أو كتلة أو ثابت.
- Terminator: آخر تعليمة في الكتلة.
- SourceLocation: موضع بداية العقدة في مصدر QX.

الشكل العام:

```json
{
  "format": "QIR",
  "version": "1.0",
  "module_id": "module_0",
  "unicode_version": "18.0.0",
  "globals": [],
  "initializer": {},
  "functions": []
}
```

لا تنفذ تعريفات الدوال داخل initializer. تسجل الدوال قبل خفض الاستدعاءات لدعم forward calls والاستدعاء الذاتي. كتل IF/WHILE في QIR تمثل تدفق التحكم ولا تنشئ نطاقًا معجميًا جديدًا.

Function:

```json
{
  "id": "fn_0",
  "kind": "module_initializer",
  "name": null,
  "parameters": [],
  "return_type": "NULL",
  "entry_block": "bb_0",
  "blocks": []
}
```

الدالة العادية تستخدم kind=function واسمًا ومعاملات. initializer دالة داخلية بنوع إرجاع NULL وتنتهي بـ RETURN ضمني بلا قيمة. لكل Function كتلة دخول واحدة موجودة ضمنها. كل BasicBlock له id وinstructions، وآخر instruction فيه هو terminator.

## 3. المعرفات والحتمية

| المجال | الصيغة | نطاق التفرد |
|---|---|---|
| Module | module_0 | الوحدة |
| Function | fn_0 | الوحدة |
| BasicBlock | bb_0 | الدالة |
| Instruction | inst_0 | الدالة |
| Value | v_0 | الدالة |
| Parameter | arg_0 | الدالة |
| Variable | var_0 | نطاق التخزين |

- المعرفات فريدة ضمن نطاقها، والعداد يبدأ من صفر ويزداد.
- تخصيصها ثابت بترتيب المصدر والاجتياز البنيوي للعقد.
- يحجز `fn_0` لدالة initializer؛ وتبدأ دوال QX المعرفة من `fn_1` بترتيب ظهورها في المصدر. لا تتكرر معرفات الدوال.
- معرفات الكتل والتعليمات والقيم فريدة عبر جميع كتل الدالة.
- معرفات globals فريدة في الوحدة، والمحليات والمؤقتات فريدة في الدالة.
- لا تستخدم قيم عشوائية أو عناوين ذاكرة أو أوقات ضمن المعرفات.
- المتغيرات المؤقتة المولدة من المحول تتبع صيغة var وتوسم generated=true.

## 4. الأنواع والقيم

الأنواع الأساسية في Semantic Analyzer هي NUM وTXT وBOOL وLIST. أما NULL فقيمة خاصة وليست نوعًا أساسيًا لاستنتاج متغير أو معامل. الإجراء الذي لا يحتوي RETURN صريحًا نوع نتيجته NULL. لا يستنتج DATA.CREATE نوع متغير من NULL، ولا تقبل QX V1 إرجاع NULL صراحة كقيمة دالة. القوائم LIST تسمح بعناصر من أنواع مختلفة.

كل تعليمة منتجة لقيمة تحمل result وtype؛ وما لا ينتج قيمة لا يحمل أيًا منهما. لا يعاد تعريف Value ID. CONST_NULL يمثل قيمة NULL حيث تسمح القيود الدلالية بذلك.

شكل التعليمة:

```json
{
  "id": "inst_0",
  "opcode": "CONST_NUM",
  "result": "v_0",
  "type": "NUM",
  "operands": { "value": 42 },
  "source": { "line": 1, "column": 1, "offset": 0 }
}
```

source يحفظ line وcolumn وoffset من AST. offset بوحدات UTF-16، وcolumn بعدد نقاط Unicode البرمجية وفق Lexer. AST الحالي لا يوفر نهاية العقدة، لذلك لا يحتوي QIR endLine أو endColumn أو endOffset.

## 5. عقود التعليمات

### الثوابت
| Opcode | operands | result type |
|---|---|---|
| CONST_NUM | value:number محدود صالح في JSON | NUM |
| CONST_TXT | value:string | TXT |
| CONST_BOOL | value:boolean | BOOL |
| CONST_NULL | لا شيء | NULL |

لا يسمح بـ NaN أو Infinity.

### المتغيرات والتخزين
| Opcode | operands | النتيجة |
|---|---|---|
| DECLARE | variable,name,storage,declared_type | لا شيء |
| LOAD | variable | نوع المتغير |
| STORE_LOCAL | variable,value | لا شيء |
| STORE_GLOBAL | variable,value | لا شيء |

storage إما local أو global. DECLARE ينشئ خانة غير مهيأة؛ يلزم STORE لتهيئتها. LOAD يتطلب تعريفًا وتهيئة مؤكدة على كل المسارات. STORE_LOCAL يكتب محليًا/معاملًا. STORE_GLOBAL يكتب متغير وحدة موجودًا ولا ينشئه. يجب تطابق نوع القيمة مع نوع المتغير.

### العمليات
| Opcode | operands | النتيجة |
|---|---|---|
| UNARY | operator,value | حسب العامل |
| BINARY | operator,left,right | حسب العامل |

| العامل | المدخلات | الناتج |
|---|---|---|
| unary + و- | NUM | NUM |
| - * / | NUM, NUM | NUM |
| % | عددان صحيحان من NUM | NUM |
| + | NUM, NUM | NUM |
| + | TXT, TXT | TXT |
| > >= < <= | NUM,NUM أو TXT,TXT | BOOL |
| == != | نوعان متوافقان ومتماثلان | BOOL |
| AND OR | BOOL,BOOL | BOOL |
| NOT | BOOL | BOOL |

لا توجد تحويلات ضمنية. القسمة على صفر خطأ وقت التشغيل. % للأعداد الصحيحة فقط؛ وبما أن NUM لا يميز الصحيح عن العشري ساكنًا، يفحص التنفيذ كون القيمتين صحيحتين وقت التشغيل، ويرفض المقسوم عليه صفرًا. ترتيب النصوص في المقارنات الترتيبية يتبع Unicode بعد التطبيع. AND/OR يجب أن يكونا short-circuit لا تقييمًا eager. لا توجد مقارنات متسلسلة.

لا يضيف QIR معنى جديدًا لمساواة LIST. يسمح Semantic Analyzer بتوافق النوع، لكن الدلالة التشغيلية الدقيقة لمساواة القوائم يجب أن يحددها Runtime قبل اعتبار تنفيذ == و!= للقوائم مكتملاً؛ لا نفترض مساواة مرجعية أو بنيوية.

### القوائم
MAKE_LIST(elements:[ValueRef]) ينتج LIST ويحافظ على ترتيب المصدر ويسمح بتنوع أنواع العناصر.

### الدوال والأوامر
| Opcode | operands | النتيجة |
|---|---|---|
| CALL | function,arguments | نوع إرجاع الدالة أو لا شيء عند إهمال النتيجة/استدعاء إجراء |
| COMMAND_CALL | command,arguments | NUM لـ DATA.COUNT كتعبير فقط |

CALL يتطلب دالة موجودة، وعدد وسائط وأنواعًا متوافقة. الاستدعاءات الأمامية والذاتية مسموحة. الإجراء NULL لا يستخدم كتعبير ذي قيمة؛ يمكن استدعاؤه كتعليمة مستقلة. يجوز إهمال نتيجة دالة ذات قيمة.

حدود الأوامر:
- الأوامر المفعّلة في Registry: DATA.COUNT وPROCESS.CALCULATE وPROCESS.COMPARE.
- DATA.COUNT وحده له عقد قيمة تعبيرية: LIST واحد ونتيجة NUM.
- PROCESS.CALCULATE يخزن تعبير NUM في هدف NUM معلن مسبقًا.
- PROCESS.COMPARE يخزن تعبير BOOL في هدف BOOL معلن مسبقًا.
- DATA.CREATE وDATA.SET وDATA.SET_GLOBAL لها معالجة خاصة داخل Semantic Analyzer رغم أنها ليست أوامر مفعّلة في Registry؛ تخفض إلى DECLARE/STORE ولا تصدر كـ COMMAND_CALL.
- لا يصدر COMMAND_CALL لأي أمر آخر ولا يمنح أي أمر غير مفعّل عقدًا جديدًا.

### تدفق التحكم
| Opcode | operands | النتيجة |
|---|---|---|
| BRANCH | condition,true_target,false_target | لا شيء |
| JUMP | target | لا شيء |
| RETURN | value اختياري | لا شيء |

BRANCH يتطلب BOOL ووجهتين في الدالة نفسها. JUMP وجهته كتلة في الدالة نفسها. RETURN بقيمة يطابق نوع الدالة. RETURN بلا قيمة صالح فقط لإجراء NULL أو initializer. مصدر QX يتطلب قيمة في RETURN الصريح؛ RETURN بلا قيمة في QIR تمثيل داخلي لنهاية إجراء بلا RETURN صريح. كل كتلة لها terminator واحد في آخر instruction ولا fallthrough. BREAK وCONTINUE غير موجودتين في V1.

## 6. تحويل AST إلى QIR

| AST node | التحويل |
|---|---|
| Program | Module + initializer + globals/functions |
| NumberLiteral | CONST_NUM |
| StringLiteral | CONST_TXT |
| BooleanLiteral | CONST_BOOL |
| NullLiteral | CONST_NULL مع القيود الدلالية |
| Identifier | LOAD |
| GroupExpression | خفض التعبير الداخلي بلا تعليمة |
| ListLiteral | خفض العناصر ثم MAKE_LIST |
| UnaryExpression | UNARY |
| BinaryExpression | BINARY أو CFG لـ AND/OR |
| CallExpression | CALL |
| CommandCallExpression | COMMAND_CALL لـ DATA.COUNT فقط |
| CommandStatement | توجيه حسب domain/command إلى عقد التخزين أو الأمر المعتمد أدناه |
| DATA.CREATE | DECLARE ثم STORE المناسب |
| DATA.SET | STORE_LOCAL أو STORE_GLOBAL وفق النطاق |
| DATA.SET_GLOBAL | STORE_GLOBAL لمتغير وحدة موجود |
| PROCESS.CALCULATE | خفض NUM ثم تخزين الهدف |
| PROCESS.COMPARE | خفض BOOL ثم تخزين الهدف |
| DATA.COUNT statement | COMMAND_CALL مع إهمال النتيجة |
| IfStatement | BRANCH وJUMP وكتل الفروع والدمج |
| WhileStatement | كتلة شرط وجسم وخروج وقفزة رجوع |
| ReturnStatement | RETURN |
| ExpressionStatement | CALL مستقل مع إهمال النتيجة |
| FunctionDeclaration | Function مستقلة |

### Lowering Context

ينشئ المحول سياقًا مستقلًا يحتوي خريطة globals من SemanticAnalysis، وخريطة locals/parameters لكل دالة، وربط الاسم بمعرف المتغير ونوعه ونطاقه، وجداول معرفات الدوال والكتل والتعليمات والقيم، والكتلة الحالية وحالة إنهائها وموضع المصدر والمتغيرات المؤقتة. لا يتطلب ذلك تعديل Semantic Analyzer. يجب رفض AST أو تحليل دلالي غير صالح.

### DATA.CREATE وعمليات التخزين

DATA.CREATE تخفض إلى DECLARE ثم تخزين القيمة الابتدائية. تختار global خارج الدوال وlocal داخلها. DATA.SET يحدّث المحلي داخل الدالة، أو global خارجها، وفق قواعد QX V1. تعديل global من دالة يتطلب DATA.SET_GLOBAL.

### IF وWHILE

IF يخفض الشرط إلى BOOL ثم BRANCH إلى consequent وalternate، مع merge عند وجود مسار يستمر. WHILE ينشئ condition وbody وexit؛ يبدأ التنفيذ بالانتقال إلى condition، ويعود body إليها ما لم ينته المسار بـ RETURN. كل كتلة، حتى الفارغة، يجب أن تنتهي صراحة.

### Short-Circuit دون PHI

في A AND B: يقيّم A أولًا؛ إذا كانت false يخزن false في متغير BOOL مؤقت دون تقييم B؛ وإذا كانت true يقيّم B ويخزن نتيجته. في A OR B: إذا كانت A true يخزن true دون تقييم B؛ وإلا يقيّم B. تلتقي المسارات ثم LOAD للمتغير المؤقت. يجب أن يثبت Validator أن كل مسار إلى merge هيأ المتغير.

## 7. المتغيرات والنطاق والتهيئة

- متغيرات المستوى الأعلى عامة؛ ومعاملات ومتغيرات الدوال محلية.
- الدوال تستطيع قراءة globals.
- تعديل global من دالة يتطلب STORE_GLOBAL.
- يمنع حجب global بمتغير محلي بالاسم نفسه.
- IF/WHILE لا تنشئ نطاقًا معجميًا.
- LOAD يتطلب تهيئة مؤكدة على جميع المسارات.
- يطبق Validator definite-assignment analysis على CFG، ويأخذ تقاطع المتغيرات المهيأة عند نقاط الدمج.
- يجب التحقق من قراءة globals داخل الدوال عند CALL: يستخرج لكل دالة ملخص globals-read، ويفحص أن كل global تقرؤه الدالة مهيأ على كل مسار يصل إلى الاستدعاء. تحسب الملخصات حتى الثبات لدعم الاستدعاءات الأمامية والذاتية.
- هذه فحوص سلامة إضافية ولا تعدل Semantic Analyzer.

## 8. عقد الدوال

كل Function عادية تحتوي id وname ومعاملات مرتبة، ولكل معامل arg ID ونوع ومعرف متغير محلي، ونوع إرجاع مستنتج، وentry وblocks.

1. الدوال top-level فقط ولا توجد nested functions.
2. تسجل الدوال قبل خفض الأجسام لدعم forward/recursive calls.
3. أنواع المعاملات تستنتج من قيود الجسم والاستدعاءات وفق Semantic Analyzer.
4. لا يفترض نوع افتراضي لمعامل غير محسوم.
5. كل مسارات الدالة ذات القيمة تنتهي بـ RETURN متوافق.
6. لا يجوز fallthrough في دالة ذات قيمة.
7. الدالة التي لا تحتوي RETURN صريحًا إجراء نوعه NULL وتنتهي بـ RETURN ضمني بلا قيمة.
8. RETURN الصريح في QX يتطلب قيمة؛ ولا يقبل NULL كقيمة إرجاع مستنتجة.
9. استدعاء الإجراء مستقل فقط لا كتعبير.
10. الاستدعاء الذاتي والمتداخل مسموحان ضمن حد عمق التنفيذ الذي يفرضه المحرك.

## 9. QIR Validator

يعمل بالترتيب التالي:
1. Schema: format/version والحقول وأنواع JSON.
2. Identifiers: التفرد وصحة المراجع.
3. Opcode contracts: opcode معروف وoperands مطابق.
4. Types: أنواع النتائج والمعاملات والقيم والدوال والأوامر.
5. Definitions: كل Value معرفة قبل الاستخدام وتعريفها يهيمن على موضع الاستخدام.
6. Variables: صحة النطاق والتخزين والتهيئة.
7. Functions: المعاملات والاستدعاءات والإرجاع.
8. CFG: entry والنهايات والقفزات وعدم وجود fallthrough.
9. Globals: تهيئة globals قبل قراءتها المباشرة وغير المباشرة عبر CALL.
10. Source/Unicode: مواضع المصدر ونسخة Unicode.
11. Determinism: ثبات ترتيب الوحدة والتسلسل.

قواعد CFG: لكل دالة entry موجود؛ كل وجهة داخل الدالة نفسها؛ كل كتلة تنتهي مرة واحدة؛ لا تعليمات بعد terminator؛ لا انتقال ضمني؛ كل مسار قابل للوصول ينتهي صحيحًا؛ RETURN يطابق نوع الدالة؛ BRANCH شرطه BOOL؛ Value definitions تهيمن على الاستخدام. لا يشترط أن تكون كل كتلة قابلة للوصول، لكن الكتل غير القابلة للوصول تخضع لكل الفحوص البنيوية والنوعية.

### Diagnostics

```json
{
  "code": "QIR_E_TYPE_MISMATCH",
  "severity": "ERROR",
  "message": "Operand type mismatch",
  "location": { "line": 4, "column": 8, "offset": 32 },
  "function": "fn_1",
  "block": "bb_1",
  "instruction": "inst_5"
}
```

حقول function/block/instruction اختيارية. الأكواد:
- QIR_E_SCHEMA
- QIR_E_DUPLICATE_ID
- QIR_E_UNDEFINED_REF
- QIR_E_USE_BEFORE_DEF
- QIR_E_TYPE_MISMATCH
- QIR_E_INVALID_OPCODE
- QIR_E_INVALID_OPERAND
- QIR_E_UNINITIALIZED_VAR
- QIR_E_INVALID_FUNCTION
- QIR_E_INVALID_RETURN
- QIR_E_INVALID_BLOCK
- QIR_E_INVALID_JUMP
- QIR_E_INVALID_SOURCE
- QIR_E_UNSUPPORTED_COMMAND
- QIR_E_NONDETERMINISTIC

تجمع الأخطاء المستقلة، ولا تصدر أخطاء مشتقة فقط من خطأ سابق. ترتيب التشخيصات حتمي: offset ثم function ثم block ثم instruction ثم code.

## 10. JSON والتسلسل

1. JSON هو تنسيق التبادل الرسمي الوحيد في V1.
2. UTF-8 دون BOM، ونهاية سطر LF.
3. يستخدم JSON Canonicalization Scheme (RFC 8785) للكائنات المدعومة.
4. يمنع NaN وInfinity وأي قيمة ليست JSON صالحة.
5. لا يعاد ترتيب arrays؛ ترتيب الدوال والكتل والتعليمات والوسائط ثابت.
6. لا تفقد مواقع المصدر أو Unicode metadata.
7. Importer يتحقق من Schema ثم يشغل Validator كاملًا قبل القبول.
8. لا يتجاهل الحقول الإلزامية ولا يحول نوعًا مجهولًا بصمت.
9. أي تغيير غير متوافق في البنية يتطلب إصدارًا جديدًا ولا يغير معنى 1.0 بصمت.

## 11. Unicode ومواقع المصدر

- unicode_version يساوي 18.0.0.
- تحترم قواعد XID_Start وXID_Continue وNFC للمعرفات كما ينفذها Lexer.
- لا يعيد QIR تطبيع النصوص أو المعرفات بطريقة تخالف القيم التي وصلته من Lexer/Parser.
- المقارنات النصية الترتيبية تتبع Unicode بعد التطبيع وفق QX V1.
- تحفظ line وcolumn وoffset كما هي في AST؛ offset بوحدات UTF-16 وcolumn بنقاط Unicode البرمجية.
- لا تضاف حقول نهاية المصدر حتى يوفر AST تلك البيانات.

## 12. أمثلة مرجعية مختصرة

مصدر:
```qx
DATA.CREATE(total, 2 + 3)
```

خفض مختصر:
```text
DECLARE var_0 name=total storage=global declared_type=NUM
v_0 = CONST_NUM 2
v_1 = CONST_NUM 3
v_2 = BINARY + v_0, v_1
STORE_GLOBAL var_0, v_2
```

PROCESS.CALCULATE:
```qx
PROCESS.CALCULATE(total, price * quantity)
```
```text
v_0 = LOAD var_price
v_1 = LOAD var_quantity
v_2 = BINARY * v_0, v_1
STORE_LOCAL var_total, v_2
```

DATA.COUNT كتعبير:
```qx
DATA.CREATE(size, DATA.COUNT(items))
```
```text
v_0 = LOAD var_items
v_1 = COMMAND_CALL DATA.COUNT [v_0] : NUM
DECLARE var_size ...
STORE_LOCAL var_size, v_1
```

دالة:
```qx
FUNCTION add(a, b)
    RETURN a + b
END
```
تخفض إلى Function ذات arg IDs، وLOAD للمعاملين، وBINARY +، وRETURN بالقيمة.

إجراء بلا RETURN صريح ينتهي بـ RETURN بلا قيمة، ونوعه NULL.

## 13. اختبارات القبول

يجب أن تغطي الاختبارات:
1. Module وinitializer والدوال.
2. كل AST nodes المدعومة في جدول التحويل.
3. الثوابت والأنواع وقيود NULL.
4. القوائم المختلطة وحفظ ترتيبها.
5. عقود UNARY/BINARY، بما فيها TXT+TXT وNUM+NUM.
6. رفض الأنواع غير المتوافقة والمقارنات المتسلسلة.
7. القسمة على صفر وشرط integer لـ %.
8. AND/OR short-circuit مع إثبات عدم تقييم الطرف الثاني عند حسم الأول.
9. IF/ELSE المتداخل وWHILE وتدفق التحكم.
10. globals/locals/parameters ومنع shadowing.
11. القراءة قبل التعريف أو التهيئة على أي مسار.
12. تهيئة globals قبل CALL الذي يقرأها، مباشرة أو بصورة متداخلة أو ذاتية.
13. forward/recursive CALL وعدد الوسائط وأنواعها.
14. كل مسارات RETURN والإجراءات ورفض الإجراء كتعبير.
15. أوامر DATA.COUNT وPROCESS.CALCULATE وPROCESS.COMPARE فقط.
16. رفض COMMAND_CALL للأوامر الأخرى.
17. معرفات مكررة ومراجع مفقودة وValue لا يهيمن تعريفها على الاستخدام.
18. terminators مفقودة/مكررة، وتعليمات بعد terminator، وقفزات بين دوال.
19. source locations مع العربية وUnicode 18.0.0.
20. تسلسل واستيراد حتميان: المدخل نفسه مرتين ينتج JSON مطابقًا.
21. JSON غير صالح وإصدار غير مدعوم وحقول إلزامية مفقودة.
22. عدم تغيير Lexer/Parser/Semantic Analyzer أو قائمة الأوامر ضمن هذه المرحلة دون قرار منفصل.

لا تُعلن المرحلة الثالثة مكتملة قبل تنفيذ هذه الاختبارات فعليًا ونجاحها.

## 14. حدود المراحل

داخل المرحلة الثالثة: مواصفة QIR، البنية، عقود التعليمات، AST lowering contract، Validator، Diagnostics، Serializer، واختبارات القبول.
خارجها: VM، Web Backend، تفعيل أوامر جديدة، تغيير الصلاحيات أو دلالات QX V1، وإعادة هيكلة Lexer/Parser/Semantic Analyzer.

## 15. مسائل توافق يجب إبقاؤها ظاهرة

1. **مساواة LIST:** التحليل الدلالي يقبل النوعين المتوافقين، لكن تفاصيل المساواة التشغيلية للقوائم ليست محددة بما يكفي في النص الحالي. يجب تثبيت عقد Runtime قبل اكتمال تنفيذ ==/!= للقوائم؛ لا نفترض مساواة مرجعية أو بنيوية.
2. **التصريحات داخل الفروع:** Semantic Analyzer يعيد استخدام النطاق نفسه داخل IF/WHILE؛ وقد تظهر قيمة معلنة في فرع ضمن جدول الرموز حتى إن لم ينفذ الفرع. Validator يرفض LOAD إذا لم تثبت التهيئة على جميع مسارات CFG. هذا فحص سلامة إضافي، ولا يغير Semantic Analyzer في هذه المرحلة.
3. **قراءة globals عبر الدوال:** التحليل الدلالي قد يعرف global لاحقًا عند تحليل جسم دالة؛ لذا يفحص QIR globals-read عند CALL لضمان التهيئة قبل القراءة.
4. **عقود Runtime:** التحقق العددي لـ % ومساواة LIST يحتاج اختبارات Runtime عند بناء VM. هذه الوثيقة تحدد العقد ولا تدعي تنفيذ السلوك.

## 16. معيار اكتمال الوثيقة والمرحلة

تعد الوثيقة موحدة عندما تضم القرارات المعتمدة دون تناقض، وتطابق AST الفعلي وSemantic Analyzer وCommand Registry التي تمت مراجعتها، وتوضح المسائل المفتوحة، وتغطي عقود كل opcode والتحويل والتدفق والأنواع والتسلسل والتشخيص والاختبارات، وتكون أمثلتها متسقة.

إضافة الوثيقة وحدها لا تغلق المرحلة الثالثة برمجيًا. يتطلب الإغلاق لاحقًا تنفيذ lowering وValidator وSerializer وتشغيل اختبارات القبول بنجاح.


## 17. امتداد QIR 1.5 — الثبات (Immutable Bindings)

### 17.1 التوافق والإصدار
- QIR 1.0–1.4 تحتفظ بمعانيها وبنية ملفاتها دون تغيير؛ غياب خاصية الثبات في هذه الإصدارات يعني السلوك القابل للتعديل الحالي.
- يصدر QIR 1.5 عندما تحتوي الوحدة على تعريف هندسي واحد أو أكثر من الرمز `VALUE`.
- لا يجوز تمرير QIR 1.5 إلى Runtime لا يدعم 1.5؛ يجب رفض الإصدار غير المدعوم بدلاً من تجاهل بيانات الثبات.

### 17.2 وصف المتغير
في QIR 1.5 يجب أن تحتوي كل Global descriptor وكل تعليمة `DECLARE` على الحقل الإلزامي:
- `mutable: true` للمتغيرات القابلة لإعادة الإسناد، بما فيها DATA وCOLLECTION والمعاملات والمتغيرات المؤقتة.
- `mutable: false` لتعريفات VALUE فقط.

يظل `STORE_LOCAL` و`STORE_GLOBAL` هما تعليمتا الكتابة؛ لا تضاف Opcode جديدة. يسمح بأول STORE لتهيئة المتغير الثابت بعد DECLARE، وتُرفض أي كتابة لاحقة. لا يجوز تغيير نوع القيمة.

### 17.3 التحقق الساكن
- يفحص Validator كل مسارات CFG، بما فيها الفروع والحلقات.
- إذا كان هناك أي مسار وصل فيه المتغير الثابت إلى حالة مهيأة قبل STORE جديد، يصدر `QIR_E_IMMUTABLE_WRITE`.
- يحظر تعديل Global ثابت من أي Function، حتى لو كان QIR مستورداً مباشرة.
- يجب أن تكون DECLARE وGlobal descriptors متسقة في قيمة `mutable`.

### 17.4 فرض Runtime
- يحتفظ VM وWeb Runtime ببيانات الثبات وحالة التهيئة لكل متغير.
- يسمح بالتهيئة الأولى فقط، ويرفض إعادة الكتابة بخطأ `QX_VM_IMMUTABLE_WRITE` حتى عند تجاوز مسار التحقق الساكن أو عند إدخال QIR غير موثوق.
- يجب أن تتطابق قواعد VM وWeb Runtime.

### 17.5 دلالات VALUE في QX
- الصيغة: `VALUE(name: Identifier, value: Expression)`، والوسيطان إلزاميان.
- VALUE تعليمة تعريف فقط وليست تعبيراً.
- تقبل NUM وTXT وBOOL وLIST، وترفض NULL أو النوع غير المحسوم.
- يمنع تكرار الاسم في النطاق نفسه، كما يمنع حجب اسم Global داخل Function وفق قاعدة QX الحالية.
- يمنع STORE وأي مسار كتابة آخر من تعديل VALUE.
- الثبات هنا يخص إعادة إسناد الربط فقط؛ لا يعني تجميد محتويات LIST الداخلية أو فرض deep immutability.

### 17.6 اختبارات القبول الإضافية
1. قبول VALUE محلياً وعالمياً وخفضه إلى QIR 1.5.
2. وجود mutable=false في Global descriptor وDECLARE الخاصين بـVALUE، وmutable=true في بقية التعريفات داخل QIR 1.5.
3. السماح بالتهيئة الأولى ورفض STORE ثانٍ.
4. رفض الكتابة إذا سبق STORE على أي مسار فرعي.
5. اختبار دورات CFG والحلقات.
6. رفض تعديل Global ثابت من Function.
7. اختبار رفض Runtime لإعادة الكتابة في VM وWeb Runtime.
8. استمرار قبول ملفات QIR 1.0–1.4 دون تغيير سلوكها.

لا يعلن دعم VALUE مكتملاً حتى تنجح اختبارات Semantic Analyzer وQIR Validator وVM وWeb Backend على Termux، ويثبت سجل الدليل ذلك.

### 17.7 نتيجة التحقق المركّز — 2026-11-28

اعتماداً على نتيجة Termux التي أرسلها مالك المشروع، اجتازت ملفات الاختبار المركزة التالية بنجاح:

- `engine/qx-core/test/qir.test.js`
- `engine/qx-core/test/vm.test.js`
- `engine/qx-core/test/web-backend.test.js`

الأمر:

```bash
node --test test/qir.test.js test/vm.test.js test/web-backend.test.js
```

النتيجة: **71 اختباراً، 71 ناجحاً، 0 فاشل، 0 ملغى، 0 متروك، 0 todo**، بمدة `846.333038 ms` على Termux بتاريخ 2026-11-28.

تغطي النتيجة مسار VALUE في QIR 1.5، ورفض التصريح الثابت المفقود أو غير المرتب، ومنع إعادة تنفيذ DECLARE الثابت في VM، وبناء أصول Web مع حراسات الثبات المولدة، واستمرار ميزات QIR السابقة في الإصدار 1.5.

**حدود الإثبات:** هذه ثلاثة ملفات اختبار مركزة وليست مجموعة Node كاملة. لا يتضمن خرج Termux إصدار Node.js أو SHA التشغيل، ولا تثبت اختبارات Web تشغيل التطبيق المولد في متصفح. لا يُنسب الاختبار إلى Commit بعينه.

### 17.8 حدود RECORD قبل اعتماد QIR 1.6 (حالة تاريخية مستبدلة بالقسم 17.9)

لا يعرّف QIR V1 نوعاً أو قيمة أو Opcode مستقلة لـ`RECORD`. لذلك:

- لا يجوز خفض `⊚ RECORD` إلى `MAKE_LIST` أو تمثيل الحقول كقائمة لمجرد أن QX V1 يدعم `ListLiteral`.
- يظل Semantic Analyzer رافضاً للرمز بـ`QX3028` حتى اعتماد شكل الحقول ونموذج النوع/القيمة.
- لا يجوز إصدار QIR قابل للتنفيذ من برنامج يحتوي RECORD غير معتمد؛ يرفض `lowerToQIR` أي تحليل دلالي غير صالح.
- لا يعلن دعم RECORD في VM أو Web Backend قبل اعتماد تمثيل QIR واختبارات التنفيذ المتطابقة.

هذا حد توافق مقصود، وليس نقصاً يجوز تجاوزه بتحويل ضمني. متطلبات فتح التنفيذ موثقة في القسم 5.12 من `GEOMETRIC-SEMANTIC-AST-CONTRACTS-V1-DRAFT.md`.

**ملاحظة الحالة:** يصف هذا القسم الوضع السابق لاعتماد Record Literal وQIR 1.6؛ لم يعد يمثل حد الدعم الحالي. القسم 17.9 هو المرجع المعتمد الحالي.

### 17.9 امتداد QIR 1.6 — RECORD

يضيف QIR 1.6 نوع القيمة `RECORD` وتعليمة البناء `MAKE_RECORD`، ولا يسمح بهذين العنصرين في الإصدارات السابقة.

**التعليمة:**

- Opcode: `MAKE_RECORD`
- النتيجة: قيمة من النوع `RECORD`.
- جميع السجلات تشترك في النوع العام `RECORD` في QIR 1.6؛ لا يفرض هذا الإصدار نوعاً بنيوياً مستقلاً لكل شكل حقول.
- Operand: `fields: [{ name: string, value: ValueId }, ...]`.
- أسماء الحقول فريدة وغير فارغة، وكل `value` مرجع إلى قيمة QIR معرفة ومهيمنة على موضع الاستخدام.
- الحد الأعلى لعدد الحقول هو 10,000 في Validator وRuntime.
- لا يوجد opcode لتعديل حقل أو الوصول إليه في QIR 1.6؛ القيمة تُنشأ ثم تُخزن في ربط RECORD ثابت.

**خفض الرمز الهندسي:** يخفض `⊚ RECORD(name, RecordLiteral)` إلى `MAKE_RECORD`، ثم `DECLARE` مع `mutable: false`، ثم STORE واحد للتهيئة. ويكون نوع global/local هو `RECORD`.

**الثبات:** يرث QIR 1.6 عقد الثبات من QIR 1.5. يمنع Validator وVM وWeb Runtime إعادة إسناد ربط RECORD أو إعادة التصريح به. هذا يثبت الربط؛ لا يضيف عمليات تعديل حقول.

**التوافق:** يجب أن يحتفظ QIR 1.6 بميزات الأوامر المضافة في 1.1–1.5، بما فيها DATA.ADD/REMOVE وUI.SHOW/TEXT وINTEGRATION.REQUEST وUI.TREE وفق حدود كل Backend.

**حدود الاستخدام في هذه المرحلة:** يمكن إنشاء السجل وقراءته كاملاً بواسطة FETCH وتمريره كمعامل أو قيمة إرجاع للدوال. لم تعتمد بعد صيغة الوصول إلى حقل منفرد أو تحديثه؛ لا يجوز اختراع وصول نقطي أو خفض الحقول إلى LIST.

**التحقق:** يجب اختبار Lexer/Parser، التحقق الدلالي، خفض QIR، رفض نوع RECORD في الإصدارات السابقة، VM execution، Web browser runtime، الحقول المكررة وNULL والحد الأعلى للحقول، وتوافق أوامر الإصدارات السابقة.


### 17.10 نتيجة التحقق المركّز من QIR 1.6 RECORD — 2026-11-28

على Termux، اجتازت مجموعتا الاختبار التاليتان:

- `node --test test/semantic-analyzer.test.js test/vm.test.js`: **75/75**، 0 فشل، بمدة `903.038923 ms`.
- `node --test test/qir.test.js test/web-backend.test.js`: **44/44**، 0 فشل، بمدة `806.790423 ms`.

تغطي النتائج خفض RECORD والتحقق من QIR 1.6، تنفيذ MAKE_RECORD وFETCH في VM، ثبات ربط RECORD، والتحقق من بناء أصول Web المولدة. المحصلة 119 اختباراً ناجحاً عبر أربعة ملفات اختبار مركزة.

**حدود الإثبات:** لم تتضمن المخرجات إصدار Node.js أو SHA التشغيل. لم يُشغّل `web-backend-runtime.test.js`؛ لذلك لا تثبت هذه النتيجة تشغيل RECORD داخل متصفح أو runtime مولد. كما لم تُشغّل اختبارات Lexer/Parser الخاصة بـRecord Literal ضمن هاتين المجموعتين. هذه ليست مجموعة الاختبارات الكاملة للمشروع.


### 17.11 استكمال تحقق RECORD في Lexer/Parser وWeb Runtime — 2026-11-28

على Termux، اجتازت المجموعة:

```bash
node --test test/geometric-symbol-lexer.test.js test/geometric-symbol-parser.test.js test/lexer-parser.test.js test/lexer-parser-boundaries.test.js test/web-backend-runtime.test.js
```

**58/58 اختباراً ناجحاً**، 0 فشل، بمدة `1042.396346 ms`. تضمنت المجموعة Lexer/Parser وحدود التحليل، واختبار `browser runtime executes QIR 1.6 immutable RECORD values`.

وبإضافة النتيجتين السابقتين (75/75 Semantic Analyzer وVM، و44/44 QIR وWeb asset generation)، أصبح مجموع التحقق المركّز لمسار RECORD **177/177** عبر ثلاث مجموعات و11 ملف اختبار. لم يظهر إصدار Node.js أو SHA التشغيل في مخرجات المستخدم، وهذه ليست مجموعة الاختبارات الكاملة للمشروع.

هذا يثبت تنفيذ Web Runtime ضمن test harness، ولا يعني نشر التطبيق أو التحقق منه في بيئة إنتاج خارجية، ولا يثبت اكتمال جميع رموز QX الـ72.


### 17.12 امتداد QIR 1.7 — أشجار الواجهة ذات النص الديناميكي

يضيف QIR 1.7 تعليمة `MAKE_UI_TREE` كي يمكن لرموز المجموعة الهندسية الثالثة `SCREEN/PANEL/BLOCK` بناء شجرة UI declarative تحتوي قيماً نصية محسوبة وقت التشغيل. لا يضيف الامتداد مكوّنات جديدة إلى سجل المضيف ولا أحداثاً أو تفاعلاً.

**التعليمة:**

- Opcode: `MAKE_UI_TREE`.
- النتيجة: `TXT` يمثل JSON لغلاف `QX.UI.TREE@1.0`.
- Operand: `tree`، واصف بنيوي مطابق لغلاف الشجرة:
  - الغلاف: `{ schema: "QX.UI.TREE", version: "1.0", children: [...] }`.
  - المكوّن: `{ kind: "component", id, type, version: "1.0.0", props: {}, children: [...] }`.
  - الأنواع المسموحة في هذا الامتداد: `UI.CONTAINER` و`UI.TEXT_BLOCK` فقط.
  - عقدة النص: `{ kind: "text", valueRef: ValueRef }`، ويجب أن يشير `valueRef` إلى قيمة QIR من النوع `TXT`.
- المعرّفات فريدة وتطابق صيغة معرفات المضيف. يجب أن تكون خصائص المكونات فارغة في هذا الامتداد.
- `UI.CONTAINER` يقبل أبناء مكونات فقط؛ `UI.TEXT_BLOCK` يقبل عقدة نص واحدة فقط.
- حدود الوصف: 1,000 عقدة كحد أقصى، وعمق 32 كحد أقصى. تخضع القيم النصية الناتجة أيضاً لحدود Runtime/UI Tree القائمة.

**التحقق:**

- يرفض Validator أي وصف غير مطابق، أو مكوّن/إصدار غير مسموح، أو معرف مكرر، أو مرجع غير معرف/غير مهيمن، أو مرجع نص ليس TXT.
- ينفذ VM وWeb Runtime الوصف بتحويل مراجع TXT إلى عقد نصية ثم تسلسل الشجرة إلى JSON؛ وبعدها يمر JSON عبر تحقق UI Tree الحالي وملف `qx.ui-lock.json` وسجل المضيف.
- لا يستخدم الامتداد `eval` أو HTML/JavaScript/CSS صادر من المصدر أو callbacks أو APIs للشبكة.
- لا يسمح هذا الامتداد بتجاوز سياسة الأطفال أو حدود الموارد أو تثبيت إصدارات المكونات.

**خفض المجموعة الثالثة:**

- `△ SCREEN` ينتج غلاف الشجرة.
- `▱ PANEL(id)` ينتج `UI.CONTAINER@1.0.0`.
- `▰ BLOCK(id, textExpression)` ينتج `UI.TEXT_BLOCK@1.0.0` مع عقدة نص مرجعية.
- يظل `UI.TREE` الأمر المضيف القائم؛ لا تتغير دلالته أو توقيعه في QIR 1.4.
- لا تدخل `WINDOW` أو `BUTTON` أو `LAYOUT` في QIR 1.7.

**التوافق:**

- لا يتغير معنى أو مخطط QIR 1.0–1.6.
- يحتفظ QIR 1.7 بميزات QIR 1.0–1.6، بما فيها الثبات وRECORD وعمليات القوائم وUI.SHOW/TEXT وINTEGRATION.REQUEST وUI.TREE.
- لا يتطلب هذا الامتداد نوع قيمة جديداً؛ `MAKE_UI_TREE` ينتج TXT، ولذلك لا يغير أنواع المتغيرات أو توقيعات الدوال.
