# الدستور الهندسي للغة QX
# QX — Geometric Language Specification

**المعرّف المرجعي | Canonical specification**  
**اسم الملف | File:** `QX-LANGUAGE-SPECIFICATION.md`  
**الحالة | Status:** مرجع الرموز الهندسية المعتمدة تصميمياً | Design-approved geometric symbol vocabulary  
**تاريخ التثبيت | Recorded:** 2026-11-28  
**الإصدار | Edition:** 0.1 — Symbol groups baseline

---

## 1. الغرض | Purpose

هذه الوثيقة هي المرجع الأساسي الموحد للأبجدية الهندسية الخاصة بلغة QX. توثق الرموز التي عُرضت على صاحب المشروع واعتمد مجموعاتها الاثنتي عشرة في المحادثة، مع الاسم الوظيفي والمعنى المحدد لكل رمز.

This document is the single canonical reference for the geometric symbol vocabulary of QX. It records the twelve symbol groups explicitly approved by the project owner, including each symbol's functional name and defined meaning.

**مبدأ حاكم | Governing principle:** الرموز الهندسية هي مفردات لغوية أصلية في QX، وليست زخرفة لأوامر تقليدية. يجب أن تُبنى قواعد اللغة ودعم المحرك لها على هذه المواصفات بعد استكمال قواعد التركيب والتحقق التقني.

The geometric symbols are native QX language tokens, not decorative aliases for conventional commands. QX grammar and engine support must be designed around this specification after composition rules and technical validation are completed.

## 2. حدود الاعتماد | Approval scope

- المجموعات الاثنتا عشرة والرموز الـ72 أدناه معتمدة من صاحب المشروع على مستوى **الشكل والاسم والوظيفة المذكورة**.
- هذا الاعتماد لا يعني أن الرموز أصبحت مدعومة في Lexer أو Parser أو VM أو Web Backend.
- لا تُخترع وظائف إضافية للرموز ولا تُغيّر معانيها دون موافقة صريحة.
- أسماء الرموز الإنجليزية أدناه أسماء تعريفية للوظائف؛ الرمز الهندسي هو العلامة اللغوية المعتمدة.
- لم تُعتمد بعد قواعد ترتيب الرموز، أو الأقواس والفواصل، أو إنهاء التعليمات، أو تركيب التعبيرات، أو أسبقية العمليات. توثّق هذه القواعد في مراجعات لاحقة.

- The twelve groups and 72 symbols below are approved for their **exact displayed form, functional name, and stated meaning**.
- This approval does not mean the symbols are already supported by the Lexer, Parser, VM, or Web Backend.
- No additional behavior may be inferred or assigned without explicit approval.
- The English symbol names are descriptive identifiers; the geometric glyph is the approved language token.
- Symbol ordering, delimiters, statement termination, expression composition, and operator precedence have not yet been approved.

## 3. الأبجدية الهندسية المعتمدة | Approved geometric vocabulary

### المجموعة 1: الإنشاء والتعريف | Group 1: Creation & Definition

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⬡ | ORIGIN | إنشاء عنصر جديد — Create a new element |
| ⬢ | FORM | تعريف بنية عنصر — Define an element structure |
| ◈ | CORE | تعريف كيان أساسي — Define a core entity |
| ⬣ | SEED | إنشاء مكوّن جديد — Create a new component |
| ⬠ | ROOT | تحديد العنصر الرئيسي — Set the root element |
| ⟐ | IDENTITY | تعريف هوية العنصر — Define an element identity |

### المجموعة 2: البيانات والتخزين | Group 2: Data & Storage

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ◉ | DATA | تعريف البيانات — Define data |
| ◍ | STORE | تخزين البيانات — Store data |
| ◌ | FETCH | جلب البيانات — Fetch data |
| ⊙ | VALUE | تحديد قيمة — Define a value |
| ⊚ | RECORD | إنشاء سجل — Create a record |
| ⊛ | COLLECTION | إنشاء مجموعة بيانات — Create a data collection |

### المجموعة 3: الواجهات والتصميم | Group 3: Interface & Design

| الرمز | الاسم | الوظيفة |
|---|---|---|
| △ | SCREEN | إنشاء شاشة — Create a screen |
| ▱ | PANEL | إنشاء لوحة — Create a panel |
| ▰ | BLOCK | إنشاء كتلة واجهة — Create a UI block |
| ◫ | WINDOW | إنشاء نافذة — Create a window |
| ⌑ | BUTTON | إنشاء زر — Create a button |
| ▤ | LAYOUT | تحديد تخطيط العناصر — Define element layout |

### المجموعة 4: التنفيذ والمعالجة | Group 4: Execution & Processing

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⟁ | EXECUTE | تنفيذ أمر — Execute a command |
| ⧫ | PROCESS | معالجة البيانات — Process data |
| ⧬ | COMPUTE | إجراء عملية حسابية — Perform a computation |
| ⧭ | TRANSFORM | تحويل البيانات — Transform data |
| ⧮ | ACTION | تنفيذ إجراء — Perform an action |
| ⧯ | FINISH | إنهاء عملية — Finish an operation |

### المجموعة 5: الشروط والقرارات | Group 5: Conditions & Decisions

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⟡ | IF | بدء شرط — Begin a condition |
| ⟢ | ELSE | مسار بديل — Alternative branch |
| ⟣ | ELSE-IF | شرط بديل — Alternative condition |
| ⟤ | EQUAL | مقارنة التساوي — Equality comparison |
| ⟥ | GREATER | مقارنة الأكبر — Greater-than comparison |
| ⟦ | LESS | مقارنة الأصغر — Less-than comparison |

### المجموعة 6: التكرار والتحكم بالتدفق | Group 6: Loops & Flow Control

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⟳ | LOOP | بدء التكرار — Begin a loop |
| ⟲ | REPEAT | إعادة تنفيذ — Repeat execution |
| ⤴ | BREAK | إيقاف التكرار — Break a loop |
| ⤵ | CONTINUE | الانتقال للدورة التالية — Continue to the next iteration |
| ⤷ | RETURN | إرجاع نتيجة — Return a result |
| ⤶ | EXIT | الخروج من التنفيذ — Exit execution |

### المجموعة 7: الربط والاتصال | Group 7: Linking & Communication

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⛓ | CONNECT | إنشاء اتصال — Establish a connection |
| ⧉ | LINK | ربط عنصرين — Link two elements |
| ⧊ | BIND | ربط مكوّن ببيانات — Bind a component to data |
| ⧋ | IMPORT | استيراد مكوّن — Import a component |
| ⧌ | EXPORT | تصدير مكوّن — Export a component |
| ⧍ | API | الاتصال بواجهة برمجية — Connect to an API |

### المجموعة 8: الحماية والصلاحيات | Group 8: Security & Permissions

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⛨ | SECURITY | تفعيل الحماية — Enable security |
| ⛉ | AUTH | التحقق من الهوية — Authenticate identity |
| ⛊ | PERMISSION | تحديد الصلاحيات — Define permissions |
| ⛋ | ACCESS | التحكم بالوصول — Control access |
| ⛌ | ENCRYPT | تشفير البيانات — Encrypt data |
| ⛍ | VALIDATE | التحقق من صحة البيانات — Validate data |

### المجموعة 9: الإدخال والإخراج | Group 9: Input & Output

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⊞ | INPUT | استقبال البيانات — Accept input data |
| ⊟ | OUTPUT | إخراج البيانات — Produce output data |
| ⊠ | READ | قراءة البيانات — Read data |
| ⊡ | WRITE | كتابة البيانات — Write data |
| ⊢ | DISPLAY | عرض المحتوى — Display content |
| ⊣ | RECEIVE | استقبال المعلومات — Receive information |

### المجموعة 10: الاستدعاء والمكونات | Group 10: Calls & Components

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⌘ | CALL | استدعاء وظيفة — Call a function |
| ⌬ | MODULE | تعريف وحدة برمجية — Define a module |
| ⌭ | COMPONENT | تعريف مكوّن — Define a component |
| ⌮ | FUNCTION | تعريف دالة — Define a function |
| ⌯ | EVENT | تعريف حدث — Define an event |
| ⌰ | TRIGGER | تشغيل حدث تلقائياً — Trigger an event automatically |

### المجموعة 11: الأخطاء والتشخيص | Group 11: Errors & Diagnostics

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⚠ | WARNING | تحذير — Warning |
| ⛔ | ERROR | خطأ — Error |
| ⛑ | RECOVER | استعادة بعد الخطأ — Recover after an error |
| ⛒ | DEBUG | فحص الأخطاء — Debug |
| ⛓️‍💥 | EXCEPTION | استثناء برمجي — Software exception |
| ⛕ | LOG | تسجيل الأحداث — Log events |

### المجموعة 12: البناء والتشغيل | Group 12: Build & Runtime

| الرمز | الاسم | الوظيفة |
|---|---|---|
| ⬟ | BUILD | بناء المشروع — Build the project |
| ⬢⃝ | COMPILE | ترجمة اللغة — Compile the language |
| ⬣⃝ | PACKAGE | تجميع المشروع — Package the project |
| ⬤ | RUN | تشغيل المشروع — Run the project |
| ⬥ | DEPLOY | نشر المشروع — Deploy the project |
| ⬦ | VERSION | تحديد إصدار المشروع — Define the project version |

## 4. قواعد حفظ الرموز | Symbol preservation rules

1. يجب حفظ كل رمز كما يظهر في الجدول، دون استبداله برمز رياضي أو معامل تقليدي.
2. يجب التعامل مع الرمز كوحدة لغوية واحدة في قواعد QX، حتى إن كان تمثيله Unicode يتكون من أكثر من code point.
3. يجب ألا تعتمد هوية الرمز على شكل الخط وحده؛ يجب توثيق تسلسله Unicode واختباره على Android وWindows والمتصفحات.
4. لا يجوز دمج الرموز المتشابهة بصرياً أو اعتبارها مترادفات.
5. يجب أن يظل مرجع Mathematics مستقلاً، ولا تُنقل رموزه إلى أبجدية QX.

1. Preserve every glyph exactly as shown; do not replace it with a mathematical symbol or conventional operator.
2. Treat each approved glyph as one QX language token, even when its Unicode representation contains multiple code points.
3. Token identity must not depend on font appearance alone; record and test its Unicode sequence across Android, Windows, and browsers.
4. Visually similar symbols must not be merged or treated as synonyms.
5. The Mathematics reference remains separate; its symbols are not part of the QX alphabet.

## 5. التحقق التقني المطلوب | Required technical validation

تتضمن المجموعة الحالية تسلسلات مركبة مثل `⬢⃝` و`⬣⃝` والرمز التعبيري المركب `⛓️‍💥`. يجب التحقق من نقاط Unicode الفعلية، وطريقة عرضها، والتقاطها كوحدات رمزية مستقلة قبل تنفيذ دعمها في المحرك. لا يُسمح بتغيير الشكل المعتمد بصمت إذا ظهرت مشكلة ترميز أو عرض؛ تُعرض المشكلة والبدائل على صاحب المشروع أولاً.

The current set includes multi-code-point sequences such as `⬢⃝`, `⬣⃝`, and the joined emoji sequence `⛓️‍💥`. Their exact Unicode code points, rendering, and token-boundary behavior must be validated before engine support is implemented. If an encoding or rendering issue appears, the approved glyph must not be silently changed; the issue and alternatives must be presented to the project owner.

## 6. ما لم يُحسم بعد | Open language decisions

هذه الوثيقة تثبت مفردات الرموز ووظائفها فقط. البنود التالية لم تحصل على اعتماد بعد:

- قواعد تركيب الرموز لتكوين تعليمة كاملة.
- طريقة تمرير القيم والمعاملات إلى الرمز.
- حدود الكتل والنطاقات وإنهاء التعليمات.
- قواعد النصوص والأرقام والقيم الحرفية.
- التعليقات والمسافات البيضاء.
- قواعد المقارنة والمنطق والأسبقية.
- التمثيل الداخلي لكل رمز وربطه بـ AST وQIR.
- سلوك الأخطاء والرسائل التشخيصية.
- اختبارات التوافق مع الرموز على المنصات المستهدفة.

This document approves the symbol vocabulary and stated meanings only. The following remain open and require separate approval:

- Composition rules for complete statements.
- Passing values and arguments to symbols.
- Block boundaries, scopes, and statement termination.
- String, numeric, and literal syntax.
- Comments and whitespace.
- Comparison, logic, and precedence rules.
- Internal representation and mapping to AST and QIR.
- Error behavior and diagnostics.
- Cross-platform symbol compatibility tests.

## 7. سجل الاعتماد | Approval record

| المجموعة | عدد الرموز | الحالة |
|---|---:|---|
| 1 — Creation & Definition | 6 | معتمدة — Approved |
| 2 — Data & Storage | 6 | معتمدة — Approved |
| 3 — Interface & Design | 6 | معتمدة — Approved |
| 4 — Execution & Processing | 6 | معتمدة — Approved |
| 5 — Conditions & Decisions | 6 | معتمدة — Approved |
| 6 — Loops & Flow Control | 6 | معتمدة — Approved |
| 7 — Linking & Communication | 6 | معتمدة — Approved |
| 8 — Security & Permissions | 6 | معتمدة — Approved |
| 9 — Input & Output | 6 | معتمدة — Approved |
| 10 — Calls & Components | 6 | معتمدة — Approved |
| 11 — Errors & Diagnostics | 6 | معتمدة — Approved |
| 12 — Build & Runtime | 6 | معتمدة — Approved |
| **الإجمالي | Total** | **72** | **12 مجموعة معتمدة** |

**سجل القرار:** اعتمد صاحب المشروع المجموعات الاثنتي عشرة تباعاً في محادثة بتاريخ 2026-11-28. لا يعني ذلك اعتماد قواعد تركيب اللغة أو إثبات تنفيذ الرموز داخل المحرك.

**Decision record:** The project owner approved all twelve groups sequentially in the conversation dated 2026-11-28. This does not constitute approval of the language composition grammar or proof that the symbols are implemented in the engine.
