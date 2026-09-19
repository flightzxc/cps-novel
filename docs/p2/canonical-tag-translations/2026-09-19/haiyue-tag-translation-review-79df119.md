# CPS海阅 CanonicalTag 多语言独立审校

日期：2026-09-19　｜　审校：GPT-6 Astra Pro　｜　冻结提交：`79df119b60b247b6ca05c2dc596246232451f26a`

## 结论

翻译验收暂不通过，建议定点修正，不全量重译。全量检查范围为 123 个 CanonicalTag × 15 个公开 locale，共 1,845 格。本报告列出 **P1 51 格（24 个标签）**，另有 **P2 21 格**非阻断建议。没有按线上事故标准另列 P0。

P1 包含明确错义、受众/角色/关系范围变化、关键含义丢失及应在上线前消除的明显歧义。P2 仅为自然度、标签风格或表达精度建议。审校判断不等于该字符串在所有上下文都必然错误；判断对象是海阅公开分类标签及其冻结含义。

本次是全量内容检查，不是十五种语言均经母语编辑签字的保证。未列出项暂不建议改动，不代表绝对无误。没有修改仓库、PR、数据库，也没有部署。

## 审查依据

- [最终 overlay](https://github.com/flightzxc/cps-novel/blob/79df119b60b247b6ca05c2dc596246232451f26a/docs/p2/canonical-tag-translations/2026-09-19/canonical-tag-translations-v1.json)
- [冻结 CanonicalTag 定义](https://github.com/flightzxc/cps-novel/blob/79df119b60b247b6ca05c2dc596246232451f26a/docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json)
- [翻译 builder](https://github.com/flightzxc/cps-novel/blob/79df119b60b247b6ca05c2dc596246232451f26a/scripts/p2-06-5-production/build-canonical-tag-translation-overlay.py)
- overlay SHA pin：`8630cb847c122485446e25921b86dee714361553bf39de16cba16558a0a80fc2`。该值用于锁定审查对象，本报告不声称重新计算远端文件字节的哈希。
- 公开语言：`en / es / pt-BR / id / vi / th / ja / ko / zh-Hant / ar / fr / de / pl / cs / ru`；原 `zh` 基准不在待修改范围。

## 重点判断

1. “萌宝题材”不能仅把“与儿童恋爱”改写成“可爱婴儿恋爱”；独立标签仍应避免儿童作为恋爱主体的歧义。建议用可爱孩子这一题材名，不强行增加单亲或秘密生子限制。
2. 复用来源合规不保证语义正确。例如德语先婚后爱、繁体中文家族纷争/单恋、部分校园/学生条目，仍存在范围或概念不一致。
3. 不把 SF、CEO、Xianxia 等通行缩写/音译，也不把简繁同形的汉字，机械判定为“漏翻”。
4. 冻结 audience facet 不能改写为主角身份；student 明确覆盖中学、大学及其他教育阶段，不能各语种各选一个阶段。

## P1：上线前处理

| ID | CanonicalTag / 中文基准 | locale | 当前译名 | 建议译名 | 原因 |
|---|---|---|---|---|---|
| TAG-L10N-001 | child-centered-romance / 萌宝题材 | en | Cute-Baby Romance | Adorable Kids | 把 baby/婴儿紧接在恋爱类型词旁，作为独立分类标签仍有“婴儿的恋爱”歧义。改为可爱孩子题材，既不暗示儿童为恋爱主体，也不额外限定单亲、秘密生子或育儿主线。 |
| TAG-L10N-002 | child-centered-romance / 萌宝题材 | es | Romance de bebé adorable | Niños adorables | 把 baby/婴儿紧接在恋爱类型词旁，作为独立分类标签仍有“婴儿的恋爱”歧义。改为可爱孩子题材，既不暗示儿童为恋爱主体，也不额外限定单亲、秘密生子或育儿主线。 |
| TAG-L10N-003 | child-centered-romance / 萌宝题材 | pt-BR | Romance de bebê fofo | Crianças adoráveis | 把 baby/婴儿紧接在恋爱类型词旁，作为独立分类标签仍有“婴儿的恋爱”歧义。改为可爱孩子题材，既不暗示儿童为恋爱主体，也不额外限定单亲、秘密生子或育儿主线。 |
| TAG-L10N-004 | child-centered-romance / 萌宝题材 | id | Romansa bayi menggemaskan | Anak-anak menggemaskan | 把 baby/婴儿紧接在恋爱类型词旁，作为独立分类标签仍有“婴儿的恋爱”歧义。改为可爱孩子题材，既不暗示儿童为恋爱主体，也不额外限定单亲、秘密生子或育儿主线。 |
| TAG-L10N-005 | child-centered-romance / 萌宝题材 | th | โรแมนซ์เบบี้น่ารัก | เด็กน่ารัก | 把 baby/婴儿紧接在恋爱类型词旁，作为独立分类标签仍有“婴儿的恋爱”歧义。改为可爱孩子题材，既不暗示儿童为恋爱主体，也不额外限定单亲、秘密生子或育儿主线。 |
| TAG-L10N-006 | legitimate-daughter / 嫡女 | vi | Con gái đích tôn | Đích nữ | đích tôn 指嫡长孙一类的宗系概念，不能用来表示正妻所生的女儿；采用小说语境的“嫡女”。 |
| TAG-L10N-007 | legitimate-daughter / 嫡女 | th | ธิดาแท้ | บุตรสาวภรรยาเอก | 现值表示亲生/真正的女儿，丢失正妻所生这一嫡庶区别。 |
| TAG-L10N-008 | love-after-marriage / 先婚后爱 | de | Liebe nach der Ehe | Erst heiraten, dann lieben | nach der Ehe 容易理解为婚姻结束之后；需表达先结婚、再相爱，而不是婚姻结束后的爱情。 |
| TAG-L10N-009 | estrangement / 关系疏离 | ko | 소원 | 멀어진 관계 | 소원 单独作为标签容易被读成“愿望”；需明确关系变得疏远，不能仅截取 소원하다 的词干。 |
| TAG-L10N-010 | single-mother / 单亲妈妈 | ko | 미혼모 | 싱글맘 | 미혼모 特指未婚母亲；单亲妈妈还包括离婚、丧偶等情况，不能缩成未婚这一条件。 |
| TAG-L10N-011 | single-mom-escape / 带娃逃离 | ko | 미혼모의 탈출 | 싱글맘의 탈출 | 沿用 Single Mom Escape 的题材含义，但去除“未婚母亲”这一额外限制；与 single-mother 的术语保持一致。 |
| TAG-L10N-012 | family-feud / 家族纷争 | zh-Hant | 豪門恩怨 | 家族紛爭 | 现值额外加入豪门/富裕家族限制；冻结标签没有这一必要条件。 |
| TAG-L10N-013 | unrequited-love / 单恋 | zh-Hant | 暗戀 | 單戀 | 暗恋描述是否公开，单恋描述感情是否单向；暗恋不一定没有回应，两者不等价。 |
| TAG-L10N-014 | mother-in-law / 婆媳关系 | zh-Hant | 婆婆 | 婆媳關係 | 冻结中文定义是关系题材，不只是某一个角色的身份。 |
| TAG-L10N-015 | ensemble-darling / 团宠 | vi | Được cả nhà cưng | Được mọi người cưng chiều | 现值把团宠限定为全家宠爱；团宠也可能来自团队、朋友或其他群体。 |
| TAG-L10N-016 | ensemble-darling / 团宠 | ko | 단체 총아 | 모두에게 사랑받는 주인공 | 现值是生硬的“团体宠儿”拼接，难以直接传达众人宠爱主角的小说设定。 |
| TAG-L10N-017 | frenemies / 亦敌亦友 | id | Musuh dalam selimut | Teman sekaligus musuh | 现值是“隐藏在身边的敌人/内鬼”的习语；不等同于兼具朋友与竞争对手关系。 |
| TAG-L10N-018 | blind-date / 相亲 | vi | Hẹn mù | Xem mắt | 现值是逐词直译；以小说中的相亲含义采用自然表达。 |
| TAG-L10N-019 | blind-date / 相亲 | th | เดทตามนัด | นัดบอด | 现值仅表示按约会面/约好的约会，没有陌生对象相亲或盲约的关键含义。 |
| TAG-L10N-020 | male-audience / 男性向 | es | Para lectores | Público masculino | 普通阳性复数“读者”可泛指全部读者，并没有明确男性受众；此标签的 facet 是 audience，必须保留男性导向。 |
| TAG-L10N-021 | male-audience / 男性向 | pt-BR | Para leitores | Público masculino | 普通阳性复数“读者”可泛指全部读者，并没有明确男性受众；此标签的 facet 是 audience，必须保留男性导向。 |
| TAG-L10N-022 | one-night-stand / 一夜情 | vi | Một đêm | Tình một đêm | 现值只剩“一晚”或“一晚的事件”，丢失短暂亲密关系的题材含义；补足关系语义。 |
| TAG-L10N-023 | one-night-stand / 一夜情 | th | คืนเดียว | ความสัมพันธ์ชั่วคืน | 现值只剩“一晚”或“一晚的事件”，丢失短暂亲密关系的题材含义；补足关系语义。 |
| TAG-L10N-024 | one-night-stand / 一夜情 | ar | ليلة واحدة | علاقة لليلة واحدة | 现值只剩“一晚”或“一晚的事件”，丢失短暂亲密关系的题材含义；补足关系语义。 |
| TAG-L10N-025 | one-night-stand / 一夜情 | ru | Случай на одну ночь | Связь на одну ночь | 现值只剩“一晚”或“一晚的事件”，丢失短暂亲密关系的题材含义；补足关系语义。 |
| TAG-L10N-026 | substitute-marriage / 替嫁 | en | Marriage Substitute | Substitute Bride | 现值倾向“婚姻的替代品/替代婚姻”，或是生硬的换序直译；替嫁是由替代的新娘代他人出嫁，不是换一种婚姻制度。 |
| TAG-L10N-027 | substitute-marriage / 替嫁 | es | Matrimonio sustituto | Novia sustituta | 现值倾向“婚姻的替代品/替代婚姻”，或是生硬的换序直译；替嫁是由替代的新娘代他人出嫁，不是换一种婚姻制度。 |
| TAG-L10N-028 | substitute-marriage / 替嫁 | pt-BR | Casamento Substituto | Noiva substituta | 现值倾向“婚姻的替代品/替代婚姻”，或是生硬的换序直译；替嫁是由替代的新娘代他人出嫁，不是换一种婚姻制度。 |
| TAG-L10N-029 | substitute-marriage / 替嫁 | vi | Thay thế kết hôn | Gả thay | 现值倾向“婚姻的替代品/替代婚姻”，或是生硬的换序直译；替嫁是由替代的新娘代他人出嫁，不是换一种婚姻制度。 |
| TAG-L10N-030 | substitute-marriage / 替嫁 | ar | زواج بديل | عروس بديلة | 现值倾向“婚姻的替代品/替代婚姻”，或是生硬的换序直译；替嫁是由替代的新娘代他人出嫁，不是换一种婚姻制度。 |
| TAG-L10N-031 | cross-dressing / 异装 | es | Vestirse del sexo opuesto | Vestirse con ropa del otro género | 现值的 vestirse de 搭配不完整；补足穿着另一性别通常穿着的衣物，避免表达成改变性别。 |
| TAG-L10N-032 | cross-dressing / 异装 | pt-BR | Vestir-se do sexo oposto | Vestir roupas do outro gênero | 现值的 vestir-se do 搭配不成立；应表达衣着，而不是“穿成一种性别”。 |
| TAG-L10N-033 | student / 学生 | id | Mahasiswa | Pelajar | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-034 | student / 学生 | vi | Học sinh | Học sinh, sinh viên | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-035 | student / 学生 | th | นักเรียน | นักเรียนและนักศึกษา | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-036 | student / 学生 | fr | Étudiant | Élèves et étudiants | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-037 | student / 学生 | de | Student | Schüler und Studierende | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-038 | student / 学生 | pl | Student | Uczniowie i studenci | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-039 | student / 学生 | ru | Студент | Учащиеся | 冻结定义明确覆盖中学、大学及其他教育阶段；现值偏大学生或仅中小学生，不能让各语种对应不同教育阶段。 |
| TAG-L10N-040 | campus / 校园 | th | รั้วมหาวิทยาลัย | ชีวิตในโรงเรียนและมหาวิทยาลัย | 现值明确限定大学；冻结定义同时包含学校、大学及校园生活，不能漏掉中学校园。 |
| TAG-L10N-041 | campus / 校园 | ar | الحرم الجامعي | الحياة المدرسية والجامعية | 现值明确是大学校园；需覆盖冻结定义中的学校与大学生活。 |
| TAG-L10N-042 | arranged-marriage / 包办婚姻 | ru | Договорной брак | Брак по договорённости семей | 现值容易与另一个标签 contract-marriage 的契约婚姻混淆；应说明由家庭安排，而不是双方订立婚姻契约。 |
| TAG-L10N-043 | arranged-marriage / 包办婚姻 | ja | 政略結婚 | 親が決めた結婚 | 政略结婚是为政治、家族或利益目的的联姻，比一般由父母安排的婚姻更窄；不宜替代整个包办婚姻标签。 |
| TAG-L10N-044 | comeback / 逆袭 | vi | Lật ngược | Lội ngược dòng | 现值是缺少宾语的“翻转”或普通“返回”；冻结标签指由不利处境翻盘，不能仅表示再次出现。 |
| TAG-L10N-045 | comeback / 逆袭 | ar | عودة | قلب الموازين | 现值是缺少宾语的“翻转”或普通“返回”；冻结标签指由不利处境翻盘，不能仅表示再次出现。 |
| TAG-L10N-046 | comeback / 逆袭 | pl | Powrót | Odwrócenie losu | 现值是缺少宾语的“翻转”或普通“返回”；冻结标签指由不利处境翻盘，不能仅表示再次出现。 |
| TAG-L10N-047 | comeback / 逆袭 | cs | Návrat | Obrat k lepšímu | 现值是缺少宾语的“翻转”或普通“返回”；冻结标签指由不利处境翻盘，不能仅表示再次出现。 |
| TAG-L10N-048 | son-in-law-comeback / 赘婿逆袭 | ar | عودة الصهر | صعود الصهر | 现值仅表示女婿归来，未表达逆袭/崛起；保留女婿角色并表达上升。 |
| TAG-L10N-049 | sudden-wealth / 突然暴富 | ja | 成り上がり | 一攫千金 | 现值是身份或地位的上升，可以缓慢发生且不一定暴富；未表达突然获得大量财富。 |
| TAG-L10N-050 | warrior-protagonist / 战士主角 | cs | Válečný protagonista | Hlavní hrdina válečník | válečný 表示战争相关，不等于主角身份是战士；需保留角色身份而不是战争题材。 |
| TAG-L10N-051 | young-adult / 青少年 | ru | Подростковое | Для подростков | 现值是没有中心名词的中性形容词。冻结 facet 是 audience，使用“面向青少年”避免误改为青少年角色标签。 |

## P2：可选改进，不阻断发布

| ID | CanonicalTag / 中文基准 | locale | 当前译名 | 建议译名 | 原因 |
|---|---|---|---|---|---|
| TAG-L10N-052 | child-centered-romance / 萌宝题材 | ja | 萌えベビー題材 | かわいい子ども | 现值像内部说明或临时造词；建议改为自然的可爱孩子题材名，不增加育儿或亲子主线要求。 |
| TAG-L10N-053 | child-centered-romance / 萌宝题材 | ko | 귀여운 아기 소재 | 귀여운 아이들 | 去掉面向编辑人员的“素材/题材”尾词，并避免只限婴儿；当前核心含义基本可辨。 |
| TAG-L10N-054 | child-centered-romance / 萌宝题材 | fr | Thématique bébé mignon | Enfants adorables | 现值像编目说明，改为更适合前台标签的名词短语。 |
| TAG-L10N-055 | child-centered-romance / 萌宝题材 | de | Süßes-Baby-Thema | Niedliche Kinder | 现值是生硬的 Thema 拼接，建议去掉编目式尾词。 |
| TAG-L10N-056 | ensemble-darling / 团宠 | en | Ensemble Darling | Everyone's Darling | Ensemble 有演出团体/群像意味，不够直观；建议表达受众人喜爱。 |
| TAG-L10N-057 | ensemble-darling / 团宠 | th | Darling ของทุกคน | ขวัญใจทุกคน | 核心含义可辨，但可以消除不必要的英泰混写。 |
| TAG-L10N-058 | male-audience / 男性向 | pl | Dla czytelników męskich | Dla mężczyzn | 现值可懂但搭配生硬；缩为面向男性更自然。 |
| TAG-L10N-059 | one-night-stand / 一夜情 | ja | 一夜限り | 一夜限りの関係 | 补足“关系”提高独立标签可理解性；现值在言情上下文尚能推知。 |
| TAG-L10N-060 | son-in-law-comeback / 赘婿逆袭 | ja | 婿入り逆転 | 婿の逆転劇 | 当前组合生硬，建议明确是女婿的逆转故事，不是“入赘”这一动作的逆转。 |
| TAG-L10N-061 | son-in-law-comeback / 赘婿逆袭 | de | Schwiegersohn Aufstieg | Aufstieg des Schwiegersohns | 补足德语名词关系；核心逆袭含义已经存在。 |
| TAG-L10N-062 | sudden-wealth / 突然暴富 | ko | 갑작스러운 부 | 벼락부자 | 现值可懂，但“暴发户/骤富者”这一惯用表达更像分类标签。 |
| TAG-L10N-063 | age-gap-romance / 年龄差恋爱 | fr | Romance d’écart d’âge | Romance avec différence d’âge | 现值不够自然，建议调整介词结构；不改变年龄差题材范围。 |
| TAG-L10N-064 | character-growth / 人物成长 | vi | Trưởng thành nhân vật | Sự trưởng thành của nhân vật | 补全越南语名词短语关系；原意可辨。 |
| TAG-L10N-065 | fated-love / 命定之爱 | fr | Amour destiné | Amour prédestiné | 使用表达命中注定的更自然形容词。 |
| TAG-L10N-066 | love-triangle / 三角恋 | vi | Tam giác tình | Tình tay ba | 替换截短的直译结构，采用惯用题材表达。 |
| TAG-L10N-067 | mature-content / 成人向内容 | ru | Контент 18+ | Контент для взрослых | 避免仅在这一语言自行增加数值年龄阈值；不是法律评级审核。 |
| TAG-L10N-068 | royalty / 王室 | de | Königlich | Königshaus | 把无中心名词的形容词改成王室名词；原意基本可辨。 |
| TAG-L10N-069 | royalty / 王室 | pl | Królewski | Rodzina królewska | 把形容词改成王室名词短语；不改变题材。 |
| TAG-L10N-070 | royalty / 王室 | cs | Královský | Královská rodina | 把形容词改成王室名词短语；不改变题材。 |
| TAG-L10N-071 | tearjerker / 催泪 | ru | Слезоточивая история | История до слёз | слезоточивый 容易带刺激泪腺/催泪物质的联想；建议采用情感性的自然表达。 |
| TAG-L10N-072 | whirlwind-marriage / 闪婚 | ko | 번개 결혼 | 초고속 결혼 | 原文可懂，建议使用更自然的快速结婚表达；不属于语义阻断。 |

## 按语种统计

| locale | 已检查 | P1 | P2 |
|---|---:|---:|---:|
| en | 123 | 2 | 1 |
| es | 123 | 4 | 0 |
| pt-BR | 123 | 4 | 0 |
| id | 123 | 3 | 0 |
| vi | 123 | 7 | 2 |
| th | 123 | 6 | 1 |
| ja | 123 | 2 | 3 |
| ko | 123 | 4 | 3 |
| zh-Hant | 123 | 3 | 0 |
| ar | 123 | 5 | 0 |
| fr | 123 | 1 | 3 |
| de | 123 | 2 | 3 |
| pl | 123 | 2 | 2 |
| cs | 123 | 2 | 1 |
| ru | 123 | 4 | 2 |

## 不在本轮擅自更改的边界

**重生 / rebirth**：冻结中文是较宽的“重生”，不能因为韩语用了 환생、日语用了転生就自动改成 회귀/重来人生。两者是否均纳入应由 taxonomy 定义或实际样本决定。本轮不创建补丁。

**救赎 / redemption**：部分语言偏赎罪，部分偏获救。冻结定义不足以支持本轮将其统一改成纯治愈或纯赎罪；不把边界问题当确定错译强改。

**Luna**：本仓冻结含义是狼人女首领；不能根据某一本小说惯例擅自改成“Alpha 的妻子”。保留稳定身份与已定义范围。

**萌宝 / 孩子年龄**：可爱孩子不必只是婴儿。提案避免限定为婴儿，也不引入单亲、秘密生子、收养等额外题材。

## 最小实施与验收

将配套 JSON 交给开发即可。它包含明确的 before → proposedDisplayName，不需要再生成整套翻译。P2 独立保存，不默认采用。

1. 固定基线与 before 检查。若远端已有后续修正，对照差异处理，不把本报告覆盖到未知版本。
2. 对复用条目，除修改输出 overlay 外，还要给 builder 加精确的 (slug, locale) 覆盖。仅改 NEW_ROWS 会再次被 CPS 候选值盖回去；不要改变整个标签的其他 14 种语言。
3. 同步 hash、SHA pin、针对性测试和真实来源记录；最终 displayName diff 必须与采纳清单一致。保留 1,845 格覆盖，不更改 zh、slug、stableId、mapping。
4. 若新补丁需要在 X8 落库，复用已有授权及备份流程，采用新 request-id，先 dry-run；预计是若干 update、其余 unchanged，而不是重新插入 1,845 行。没有授权不执行 apply。
5. 页面只需抽查变更代表项、较长标签换行及已有分类链接，空分类 404 仍遵循现规则。不要重做整套业务验收或生产部署。

## 可直接发给开发的执行说明

```text
请根据 haiyue-tag-translation-delta-79df119.json 处理 P1 译名审校项。
先核对基线和每项 before，只修改采纳单元格；P2 不默认应用。
同步 builder 的单元格覆盖和最终 overlay，防止 CPS 复用值覆盖新译名。
更新 .sha256、CLI SHA pin 与针对性断言，检查 diff 无额外全量重译。
不得修改冻结 v1、zh、slug、标签身份、渠道 mapping 或分类算法。
本任务只提交修正和测试结果；不自动合并 PR、不自动执行数据库写入、不部署生产。
```

说明：这里的“审校通过/未通过”是独立模型的内容判断，不是 GitHub 上已经提交的 Review 状态。
