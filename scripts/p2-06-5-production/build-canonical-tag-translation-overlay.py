#!/usr/bin/env python3
"""Offline builder for CanonicalTag public-locale translation overlay.

Reads the frozen CanonicalTag v1 JSON in this repository plus optional CPS
read-only *display-name* assets (never imported by the runtime CLI). Writes
docs/p2/canonical-tag-translations/2026-09-19/canonical-tag-translations-v1.json
and a sibling .sha256 file.

TAG-I18N-ORDINAL-2026-04-19 / CPS docs/governance/tag-i18n-quarantine.md
(git object e70a1c5, not v811 HEAD): `_tags-minimax-filled.json` is
DO_NOT_USE_AS_TRANSLATION_AUTHORITY. This builder never reads that file,
never copies classifier keywords, and never treats ordinal-shifted names as
reviewed. Allowed CPS display-name sources are only:

- data/tags/tag-rule-names-repair-20260515.json (a4d60ef names repair)
- data/taxonomy/{de,pl,cs}-category-tag-i18n.json proposed *Name fields
  (de needsReview must be false; csKeywords are ignored)

Regenerate with CPS_READONLY_ROOT pointing at the CPS project parent so those
three files resolve under cps-admin-v811-search-ux/. Runtime apply path:
scripts/p2-06-5-production/canonical-tag-translation-overlay.ts
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
V1_PATH = REPO / "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json"
V1_SHA = "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad"
OUT_DIR = REPO / "docs/p2/canonical-tag-translations/2026-09-19"
OUT_JSON = OUT_DIR / "canonical-tag-translations-v1.json"
OUT_SHA = OUT_DIR / "canonical-tag-translations-v1.json.sha256"

SITE_LOCALES = [
    "en", "es", "pt-BR", "id", "vi", "th", "ja", "ko", "zh-Hant",
    "ar", "fr", "de", "pl", "cs", "ru",
]

# Haiyue slug → CPS slug, used only when the haiyue slug is absent from
# repair/de/pl/cs and KEEP_AUTHORED does not apply. Each pair was checked
# against CanonicalTag display_name_zh; mismatched tropes are not listed
# (system-fantasy≠otherworldly-system, contemporary-setting≠modern,
# urban-setting≠urban, warrior-protagonist≠warriors, tragic-ending≠be,
# fated-love≠soulmates).
SEMANTIC_MAP = {
    "werewolf-alpha": "alpha",
    "werewolf-luna": "luna",
    "contract-marriage": "contractual-marriage",
    "substitute-marriage": "marriage-substitute",
    "young-adult": "teenagers",
    "eastern-fantasy": "oriental-fantasy",
    "identity-swap": "ldentity-swap",
    "entertainment-industry": "showbiz",
    "royalty": "royal",
    "son-in-law-comeback": "son-in-laws-turnaround",
    "pregnancy": "pregnant",
}

# locale order: en es pt-BR id vi th ja ko zh-Hant ar fr de pl cs ru
NEW_ROWS: dict[str, list[str]] = {
    "adventure": ["Adventure", "Aventura", "Aventura", "Petualangan", "Phiêu lưu", "ผจญภัย", "冒険", "모험", "冒險", "مغامرة", "Aventure", "Abenteuer", "Przygodowe", "Dobrodružství", "Приключения"],
    "age-gap-romance": ["Age-Gap Romance", "Romance con diferencia de edad", "Romance com diferença de idade", "Romansa beda usia", "Ngôn tình chênh lệch tuổi", "โรแมนซ์ต่างวัย", "年の差恋愛", "나이차 로맨스", "年齡差戀愛", "رومانسية فارق العمر", "Romance d’écart d’âge", "Altersunterschied-Romanze", "Romans z różnicą wieku", "Romance s věkovým rozdílem", "Романтика с разницей в возрасте"],
    "amnesia": ["Amnesia", "Amnesia", "Amnésia", "Amnesia", "Mất trí nhớ", "ความจำเสื่อม", "記憶喪失", "기억상실", "失憶", "فقدان الذاكرة", "Amnésie", "Amnesie", "Amnezja", "Amnézie", "Амнезия"],
    "apocalypse": ["Apocalypse", "Apocalipsis", "Apocalipse", "Apokalips", "Tận thế", "วันสิ้นโลก", "終末", "종말", "末世", "نهاية العالم", "Apocalypse", "Apokalypse", "Apokalipsa", "Apokalypsa", "Апокалипсис"],
    "arranged-marriage": ["Arranged Marriage", "Matrimonio concertado", "Casamento arranjado", "Pernikahan diatur", "Hôn nhân sắp đặt", "แต่งงานคลุมถุงชน", "政略結婚", "중매결혼", "包辦婚姻", "زواج مرتب", "Mariage arrangé", "Arrangierte Ehe", "Małżeństwo zaaranżowane", "Domluvené manželství", "Договорной брак"],
    "assassin": ["Assassin", "Asesino", "Assassino", "Pembunuh bayaran", "Sát thủ", "นักฆ่า", "暗殺者", "암살자", "刺客", "قاتل مأجور", "Assassin", "Attentäter", "Zabójca", "Nájemný vrah", "Наёмный убийца"],
    "betrayal": ["Betrayal", "Traición", "Traição", "Pengkhianatan", "Phản bội", "การทรยศ", "裏切り", "배신", "背叛", "خيانة", "Trahison", "Verrat", "Zdrada", "Zrada", "Предательство"],
    "blind-date": ["Blind Date", "Cita a ciegas", "Encontro às cegas", "Kencan buta", "Hẹn mù", "เดทตามนัด", "お見合い", "맞선", "相親", "موعد أعمى", "Rendez-vous à l’aveugle", "Blind Date", "Randka w ciemno", "Rande naslepo", "Свидание вслепую"],
    "broken-heart": ["Broken Heart", "Corazón roto", "Coração partido", "Patah hati", "Trái tim tan vỡ", "อกหัก", "失恋", "실연", "失戀創傷", "قلب مكسور", "Cœur brisé", "Gebrochenes Herz", "Złamane serce", "Zlomené srdce", "Разбитое сердце"],
    "campus": ["Campus", "Campus", "Campus", "Kampus", "Học đường", "วิทยาเขต", "学園", "캠퍼스", "校園", "حرم جامعي", "Campus", "Campus", "Kampus", "Kampus", "Кампус"],
    "character-growth": ["Character Growth", "Crecimiento del personaje", "Crescimento do personagem", "Pertumbuhan karakter", "Trưởng thành nhân vật", "การเติบโตของตัวละคร", "成長譚", "캐릭터 성장", "人物成長", "تطور الشخصية", "Évolution du personnage", "Charakterentwicklung", "Rozwój postaci", "Vývoj postavy", "Рост персонажа"],
    "chef": ["Chef", "Chef", "Chef", "Koki", "Đầu bếp", "เชฟ", "シェフ", "셰프", "廚師", "طاهٍ", "Chef", "Koch", "Szef kuchni", "Šéfkuchař", "Шеф-повар"],
    "child-centered-romance": ["Cute-Baby Romance", "Romance de bebé adorable", "Romance de bebê fofo", "Romansa bayi menggemaskan", "Ngôn tình bé cưng", "โรแมนซ์เบบี้น่ารัก", "萌えベビー題材", "귀여운 아기 소재", "萌寶題材", "ثيمة الطفل اللطيف", "Thématique bébé mignon", "Süßes-Baby-Thema", "Motyw uroczego bobasa", "Téma roztomilého miminka", "Тема милого малыша"],
    "childhood-sweethearts": ["Childhood Sweethearts", "Novios de la infancia", "Namorados de infância", "Kekasih masa kecil", "Thanh mai trúc mã", "รักวัยเด็ก", "幼なじみ", "소꿉친구", "青梅竹馬", "أحبّاء الطفولة", "Amours d’enfance", "Kinderliebe", "Miłość z dzieciństwa", "Láska z dětství", "Возлюбленные с детства"],
    "comeback": ["Comeback", "Resurgimiento", "Retorno triunfal", "Kebangkitan", "Lật ngược", "คัมแบ็ก", "逆転", "역전", "逆襲", "عودة", "Retour en force", "Comeback", "Powrót", "Comeback", "Камбэк"],
    "comedy": ["Comedy", "Comedia", "Comédia", "Komedi", "Hài hước", "คอมเมดี้", "コメディ", "코미디", "喜劇", "كوميديا", "Comédie", "Komödie", "Komedia", "Komedie", "Комедия"],
    "contemporary-setting": ["Contemporary Setting", "Ambientación contemporánea", "Cenário contemporâneo", "Latar kontemporer", "Bối cảnh đương đại", "ฉากร่วมสมัย", "現代背景", "현대 배경", "當代背景", "خلفية معاصرة", "Cadre contemporain", "Gegenwartsschauplatz", "Współczesne realia", "Současné prostředí", "Современная обстановка"],
    "contract-marriage": ["Contract Marriage", "Matrimonio por contrato", "Casamento por contrato", "Pernikahan kontrak", "Hôn nhân hợp đồng", "แต่งงานตามสัญญา", "契約結婚", "계약 결혼", "契約婚姻", "زواج تعاقدي", "Mariage contractuel", "Vertragsehe", "Małżeństwo kontraktowe", "Smluvní manželství", "Брак по контракту"],
    "court-intrigue": ["Court Intrigue", "Intrigas palaciegas", "Intriga palaciana", "Intrik istana", "Cung đấu", "การเมืองในวัง", "宮廷陰謀", "궁중 암투", "宮廷權謀", "مؤامرات البلاط", "Intrigue de cour", "Hofintrige", "Intrygi dworskie", "Dvorské intriky", "Придворные интриги"],
    "crime": ["Crime", "Crimen", "Crime", "Kejahatan", "Tội phạm", "อาชญากรรม", "犯罪", "범죄", "犯罪", "جريمة", "Crime", "Krimi", "Kryminał", "Krimi", "Криминал"],
    "criminal-investigation": ["Criminal Investigation", "Investigación criminal", "Investigação criminal", "Investigasi kriminal", "Điều tra hình sự", "สืบสวนคดีอาญา", "刑事捜査", "형사 수사", "刑事偵查", "تحقيق جنائي", "Enquête criminelle", "Kriminalermittlung", "Śledztwo kryminalne", "Kriminální vyšetřování", "Уголовное расследование"],
    "cross-dressing": ["Cross-dressing", "Vestirse del sexo opuesto", "Vestir-se do sexo oposto", "Menyamar lawan jenis", "Giả trang nam/nữ", "แต่งตัวข้ามเพศ", "女装／男装", "여장/남장", "異裝", "ارتداء ملابس الجنس الآخر", "Travestissement", "Crossdressing", "Przebieranie się za inną płeć", "Převlek do druhého pohlaví", "Переодевание в одежду другого пола"],
    "crown-prince": ["Crown Prince", "Príncipe heredero", "Príncipe herdeiro", "Pangeran mahkota", "Thái tử", "มกุฎราชกุมาร", "皇太子", "태자", "太子", "ولي العهد", "Prince héritier", "Kronprinz", "Następca tronu", "Korunní princ", "Наследный принц"],
    "disability": ["Disability", "Discapacidad", "Deficiência", "Disabilitas", "Khuyết tật", "ความพิการ", "障害のある登場人物", "장애", "殘障角色", "إعاقة", "Handicap", "Behinderung", "Niepełnosprawność", "Postižení", "Инвалидность"],
    "divorce": ["Divorce", "Divorcio", "Divórcio", "Perceraian", "Ly hôn", "หย่าร้าง", "離婚", "이혼", "離婚", "طلاق", "Divorce", "Scheidung", "Rozwód", "Rozvod", "Развод"],
    "doctor": ["Doctor", "Médico", "Médico", "Dokter", "Bác sĩ", "แพทย์", "医師", "의사", "醫生", "طبيب", "Médecin", "Arzt", "Lekarz", "Lékař", "Врач"],
    "eastern-fantasy": ["Eastern Fantasy", "Fantasía oriental", "Fantasia oriental", "Fantasi timur", "Kỳ ảo phương Đông", "แฟนตาซีตะวันออก", "東方ファンタジー", "동양 판타지", "東方奇幻", "فانتازيا شرقية", "Fantasy orientale", "Östliche Fantasy", "Fantastyka wschodnia", "Východní fantasy", "Восточное фэнтези"],
    "emotional-healing": ["Emotional Healing", "Sanación emocional", "Cura emocional", "Penyembuhan emosional", "Chữa lành cảm xúc", "เยียวยาใจ", "心の癒し", "감정 치유", "情感治癒", "شفاء عاطفي", "Guérison émotionnelle", "Emotionale Heilung", "Uzdrowienie emocjonalne", "Emoční uzdravení", "Эмоциональное исцеление"],
    "emperor": ["Emperor", "Emperador", "Imperador", "Kaisar", "Hoàng đế", "จักรพรรดิ", "皇帝", "황제", "皇帝", "إمبراطور", "Empereur", "Kaiser", "Cesarz", "Císař", "Император"],
    "ensemble-darling": ["Ensemble Darling", "El consentido de todos", "Queridinho de todos", "Kesayangan semua orang", "Được cả nhà cưng", "Darling ของทุกคน", "全員から愛される", "단체 총아", "團寵", "محبوب الجميع", "Chouchou de tous", "Liebling aller", "Ulubieniec wszystkich", "Miláček všech", "Любимчик всех"],
    "entertainment-industry": ["Entertainment Industry", "Mundo del espectáculo", "Mundo do entretenimento", "Dunia hiburan", "Giới giải trí", "วงการบันเทิง", "芸能界", "연예계", "娛樂圈", "عالم الترفيه", "Industrie du divertissement", "Unterhaltungsbranche", "Show-biznes", "Zábavní průmysl", "Индустрия развлечений"],
    "estrangement": ["Estrangement", "Alejamiento", "Afastamento", "Keterasingan", "Xa cách", "ห่างเหิน", "疎遠", "소원", "關係疏離", "قطيعة", "Éloignement", "Entfremdung", "Wyobcowanie", "Odcizení", "Отчуждение"],
    "family": ["Family", "Familia", "Família", "Keluarga", "Gia đình", "ครอบครัว", "家族", "가족", "家庭", "عائلة", "Famille", "Familie", "Rodzina", "Rodina", "Семья"],
    "family-feud": ["Family Feud", "Enemistad familiar", "Rixa familiar", "Perseteruan keluarga", "Ân oán gia tộc", "ความขัดแย้งในตระกูล", "一族の確執", "가문 분쟁", "家族紛爭", "صراع عائلي", "Querelle familiale", "Familienfehde", "Konflikt rodzinny", "Rodinný spor", "Семейная вражда"],
    "fantasy": ["Fantasy", "Fantasía", "Fantasia", "Fantasi", "Kỳ ảo", "แฟนตาซี", "ファンタジー", "판타지", "奇幻", "فانتازيا", "Fantasy", "Fantasy", "Fantasy", "Fantasy", "Фэнтези"],
    "fated-love": ["Fated Love", "Amor predestinado", "Amor predestinado", "Cinta takdir", "Duyên trời định", "รักลิขิต", "運命の恋", "운명의 사랑", "命定之愛", "حب مقدّر", "Amour destiné", "Schicksalsliebe", "Przeznaczona miłość", "Osudová láska", "Предначертанная любовь"],
    "female-audience": ["Female Audience", "Para lectoras", "Para leitoras", "Untuk pembaca wanita", "Dành cho nữ", "สำหรับผู้อ่านหญิง", "女性向け", "여성향", "女性向", "موجه للنساء", "Public féminin", "Für Leserinnen", "Dla czytelniczek", "Pro čtenářky", "Для женской аудитории"],
    "first-love": ["First Love", "Primer amor", "Primeiro amor", "Cinta pertama", "Mối tình đầu", "รักแรก", "初恋", "첫사랑", "初戀", "الحب الأول", "Premier amour", "Erste Liebe", "Pierwsza miłość", "První láska", "Первая любовь"],
    "forbidden-love": ["Forbidden Love", "Amor prohibido", "Amor proibido", "Cinta terlarang", "Tình cấm", "รักต้องห้าม", "禁断の恋", "금지된 사랑", "禁忌之戀", "حب محرم", "Amour interdit", "Verbotene Liebe", "Zakazana miłość", "Zakázaná láska", "Запретная любовь"],
    "frenemies": ["Frenemies", "Amigos-enemigos", "Amigos-inimigos", "Musuh dalam selimut", "Bạn-thù", "เพื่อนรักเพื่อนแค้น", "友であり敵", "프렌에미", "亦敵亦友", "أصدقاء-أعداء", "Amis-ennemis", "Frenemies", "Przyjaciele-wrogowie", "Přátelé-nepřátelé", "Друзья-враги"],
    "from-hate-to-love": ["From Hate to Love", "Del odio al amor", "Do ódio ao amor", "Dari benci jadi cinta", "Từ hận thành yêu", "จากเกลียดกลายเป็นรัก", "嫌いから愛へ", "미움에서 사랑으로", "由恨生愛", "من الكراهية إلى الحب", "De la haine à l’amour", "Vom Hass zur Liebe", "Od nienawiści do miłości", "Z nenávisti k lásce", "От ненависти к любви"],
    "from-love-to-hate": ["From Love to Hate", "Del amor al odio", "Do amor ao ódio", "Dari cinta jadi benci", "Từ yêu thành hận", "จากรักกลายเป็นเกลียด", "愛から憎しみへ", "사랑에서 미움으로", "由愛生恨", "من الحب إلى الكراهية", "De l’amour à la haine", "Von der Liebe zum Hass", "Od miłości do nienawiści", "Z lásky k nenávisti", "От любви к ненависти"],
    "future-world": ["Future World", "Mundo futuro", "Mundo futuro", "Dunia masa depan", "Thế giới tương lai", "โลกอนาคต", "未来世界", "미래 세계", "未來世界", "عالم مستقبلي", "Monde futur", "Zukunftswelt", "Świat przyszłości", "Svět budoucnosti", "Мир будущего"],
    "gaming-esports": ["Gaming & Esports", "Videojuegos y esports", "Games e esports", "Game dan esports", "Game và esports", "เกมและอีสปอร์ต", "ゲーム／eスポーツ", "게임·e스포츠", "遊戲競技", "ألعاب إلكترونية", "Jeux et esports", "Gaming und E-Sport", "Gry i esports", "Hry a esports", "Игры и киберспорт"],
    "genius": ["Genius", "Genio", "Gênio", "Jenius", "Thiên tài", "อัจฉริยะ", "天才", "천재", "天才", "عبقري", "Génie", "Genie", "Geniusz", "Génius", "Гений"],
    "gradually-fall-in-love": ["Gradually Fall in Love", "Enamorarse poco a poco", "Apaixonar-se aos poucos", "Jatuh cinta perlahan", "Yêu dần", "ค่อยๆ รัก", "日を重ねて恋に落ちる", "점점 사랑에 빠지다", "日久生情", "وقوع في الحب تدريجياً", "Tomber amoureux peu à peu", "Allmählich verlieben", "Zakochiwać się stopniowo", "Postupné zamilování", "Постепенное влюбление"],
    "happy-ending": ["Happy Ending", "Final feliz", "Final feliz", "Ending bahagia", "Kết thúc có hậu", "แฮปปี้เอนดิ้ง", "ハッピーエンド", "해피엔딩", "圓滿結局", "نهاية سعيدة", "Fin heureuse", "Happy End", "Szczęśliwe zakończenie", "Šťastný konec", "Счастливый финал"],
    "heir": ["Heir", "Heredero", "Herdeiro", "Ahli waris", "Người thừa kế", "ทายาท", "後継者", "후계자", "繼承人", "وريث", "Héritier", "Erbe", "Dziedzic", "Dědic", "Наследник"],
    "hidden-identity": ["Hidden Identity", "Identidad oculta", "Identidade oculta", "Identitas tersembunyi", "Thân phận giấu kín", "ซ่อนตัวตน", "隠された身分", "숨겨진 신분", "隱藏身份", "هوية مخفية", "Identité cachée", "Verborgene Identität", "Ukryta tożsamość", "Skrytá identita", "Скрытая личность"],
    "historical-fiction": ["Historical Fiction", "Ficción histórica", "Ficção histórica", "Fiksi sejarah", "Tiểu thuyết lịch sử", "นิยายอิงประวัติศาสตร์", "歴史もの", "역사물", "歷史題材", "خيال تاريخي", "Fiction historique", "Historische Thematik", "Fikcja historyczna", "Historická fikce", "Историческая проза"],
    "historical-romance": ["Historical Romance", "Romance histórico", "Romance histórico", "Romansa sejarah", "Ngôn tình cổ đại", "โรแมนซ์ย้อนยุค", "時代恋愛", "사극 로맨스", "古代言情", "رومانسية تاريخية", "Romance historique", "Historische Romanze", "Romans historyczny", "Historická romance", "Историческая романтика"],
    "horror": ["Horror", "Terror", "Terror", "Horor", "Kinh dị", "สยองขวัญ", "ホラー", "호러", "恐怖", "رعب", "Horreur", "Horror", "Horror", "Horor", "Ужасы"],
    "identity-swap": ["Identity Swap", "Intercambio de identidad", "Troca de identidade", "Tukar identitas", "Đổi thân phận", "สลับตัวตน", "身分入れ替え", "신분 교체", "身份互換", "تبادل الهوية", "Échange d’identité", "Identitätstausch", "Zamiana tożsamości", "Výměna identity", "Обмен личностями"],
    "impostor": ["Impostor", "Impostor", "Impostor", "Penyamar", "Kẻ mạo danh", "คนปลอมตัว", "成りすまし", "사칭", "冒名者", "منتحل", "Imposteur", "Hochstapler", "Oszust", "Podvodník", "Самозванец"],
    "kidnapping": ["Kidnapping", "Secuestro", "Sequestro", "Penculikan", "Bắt cóc", "การลักพาตัว", "誘拐", "납치", "綁架", "اختطاف", "Enlèvement", "Entführung", "Porwanie", "Únos", "Похищение"],
    "kung-fu": ["Kung Fu", "Kung-fu", "Kung fu", "Kungfu", "Công phu", "กังฟู", "カンフー", "쿵푸", "功夫", "كونغ فو", "Kung-fu", "Kung-Fu", "Kung-fu", "Kung-fu", "Кунг-фу"],
    "lawyer": ["Lawyer", "Abogado", "Advogado", "Pengacara", "Luật sư", "ทนายความ", "弁護士", "변호사", "律師", "محامٍ", "Avocat", "Anwalt", "Prawnik", "Právník", "Адвокат"],
    "legitimate-daughter": ["Legitimate Daughter", "Hija legítima", "Filha legítima", "Putri sah", "Con gái đích tôn", "ธิดาแท้", "嫡女", "적녀", "嫡女", "الابنة الشرعية", "Fille légitime", "Eheliche Tochter", "Prawowita córka", "Legitimní dcera", "Законная дочь"],
    "lgbtq-romance": ["LGBTQ+ Romance", "Romance LGBTQ+", "Romance LGBTQ+", "Romansa LGBTQ+", "Ngôn tình LGBTQ+", "โรแมนซ์ LGBTQ+", "LGBTQ+恋愛", "LGBTQ+ 로맨스", "LGBTQ+戀愛", "رومانسية LGBTQ+", "Romance LGBTQ+", "LGBTQ+-Romanze", "Romans LGBTQ+", "LGBTQ+ romance", "ЛГБТК+ романтика"],
    "love-after-marriage": ["Love After Marriage", "Amor después del matrimonio", "Amor depois do casamento", "Cinta setelah menikah", "Yêu sau hôn nhân", "รักหลังแต่ง", "結婚してから恋に落ちる", "결혼 후 사랑", "先婚後愛", "حب بعد الزواج", "Amour après le mariage", "Liebe nach der Ehe", "Miłość po ślubie", "Láska po svatbě", "Любовь после свадьбы"],
    "love-at-first-sight": ["Love at First Sight", "Amor a primera vista", "Amor à primeira vista", "Cinta pada pandangan pertama", "Yêu từ cái nhìn đầu", "รักแรกพบ", "一目ぼれ", "첫눈에 반하다", "一見鍾情", "حب من أول نظرة", "Coup de foudre", "Liebe auf den ersten Blick", "Miłość od pierwszego wejrzenia", "Láska na první pohled", "Любовь с первого взгляда"],
    "love-triangle": ["Love Triangle", "Triángulo amoroso", "Triângulo amoroso", "Segitiga asmara", "Tam giác tình", "รักสามเส้า", "三角関係", "삼각관계", "三角戀", "مثلث عاطفي", "Triangle amoureux", "Liebesdreieck", "Trójkąt miłosny", "Milostný trojúhelník", "Любовный треугольник"],
    "mafia": ["Mafia", "Mafia", "Máfia", "Mafia", "Mafia", "มาเฟีย", "マフィア", "마피아", "黑幫", "مافيا", "Mafia", "Mafia", "Mafia", "Mafie", "Мафия"],
    "maid": ["Maid", "Criada", "Empregada", "Pembantu", "Hầu gái", "สาวใช้", "メイド", "메이드", "女僕", "خادمة", "Femme de chambre", "Zofe", "Pokojówka", "Služka", "Горничная"],
    "male-audience": ["Male Audience", "Para lectores", "Para leitores", "Untuk pembaca pria", "Dành cho nam", "สำหรับผู้อ่านชาย", "男性向け", "남성향", "男性向", "موجه للرجال", "Public masculin", "Für männliche Leser", "Dla czytelników męskich", "Pro mužské čtenáře", "Для мужской аудитории"],
    "marriage": ["Marriage", "Matrimonio", "Casamento", "Pernikahan", "Hôn nhân", "การแต่งงาน", "結婚", "결혼", "婚姻題材", "زواج", "Mariage", "Ehe", "Małżeństwo", "Manželství", "Брак"],
    "mature-content": ["Mature Content", "Contenido para adultos", "Conteúdo adulto", "Konten dewasa", "Nội dung người lớn", "เนื้อหาสำหรับผู้ใหญ่", "成人向け", "성인 콘텐츠", "成人向內容", "محتوى للبالغين", "Contenu adulte", "Inhalte für Erwachsene", "Treści dla dorosłych", "Obsah pro dospělé", "Контент 18+"],
    "military": ["Military", "Militar", "Militar", "Militer", "Quân đội", "ทหาร", "軍もの", "군", "軍旅", "عسكري", "Militaire", "Militär", "Wojsko", "Armáda", "Армия"],
    "miracle-healer": ["Miracle Healer", "Médico milagroso", "Médico milagroso", "Tabib ajaib", "Thần y", "หมอเทพ", "神医", "신의", "神醫", "طبيب معجز", "Guérisseur miracle", "Wunderheiler", "Cudowny lekarz", "Zázračný léčitel", "Чудо-лекарь"],
    "misunderstanding": ["Misunderstanding", "Malentendido", "Mal-entendido", "Kesalahpahaman", "Hiểu lầm", "ความเข้าใจผิด", "誤解", "오해", "誤會", "سوء فهم", "Malentendu", "Missverständnis", "Nieporozumienie", "Nedorozumění", "Недоразумение"],
    "modern-romance": ["Modern Romance", "Romance contemporáneo", "Romance contemporâneo", "Romansa modern", "Ngôn tình hiện đại", "โรแมนซ์สมัยใหม่", "現代恋愛", "현대 로맨스", "現代言情", "رومانسية عصرية", "Romance moderne", "Moderne Romanze", "Współczesny romans", "Moderní romance", "Современная романтика"],
    "mother-in-law": ["Mother-in-Law", "Suegra", "Sogra", "Ibu mertua", "Mẹ chồng", "แม่สามี", "姑", "시어머니", "婆媳關係", "الحماة", "Belle-mère", "Schwiegermutter", "Teściowa", "Tchyně", "Свекровь"],
    "office-romance": ["Office Romance", "Romance de oficina", "Romance no escritório", "Romansa kantor", "Tình văn phòng", "รักในออฟฟิศ", "オフィス恋愛", "사내 연애", "職場戀愛", "رومانسية المكتب", "Romance de bureau", "Büro-Romanze", "Biurowe uczucie", "Kancelářská romance", "Офисная романтика"],
    "office-tension": ["Office Tension", "Tensión en la oficina", "Tensão no escritório", "Ketegangan kantor", "Căng thẳng văn phòng", "ความตึงเครียดในออฟฟิศ", "オフィスの緊張", "사내 긴장감", "職場張力", "توتر في المكتب", "Tension au bureau", "Bürospannung", "Napięcie w biurze", "Napětí v kanceláři", "Офисное напряжение"],
    "older-adult-romance": ["Older-Adult Romance", "Romance de adultos mayores", "Romance na maturidade", "Romansa usia lanjut", "Ngôn tình trung niên", "โรแมนซ์วัยกลางคน", "中高年の恋愛", "중장년 로맨스", "中老年戀愛", "رومانسية كبار السن", "Romance d’âge mûr", "Romanze im späteren Alter", "Romans dojrzały", "Romance ve zralém věku", "Романтика зрелого возраста"],
    "one-night-stand": ["One-Night Stand", "Aventura de una noche", "Ficada de uma noite", "Hubungan semalam", "Một đêm", "คืนเดียว", "一夜限り", "원나잇", "一夜情", "ليلة واحدة", "Aventure d’un soir", "One-Night-Stand", "Przygoda na jedną noc", "Jedna noc", "Случай на одну ночь"],
    "playboy": ["Playboy", "Playboy", "Playboy", "Playboy", "Sở khanh", "เพลย์บอย", "プレイボーイ", "플레이보이", "花花公子", "لاعب نساء", "Playboy", "Playboy", "Playboy", "Playboy", "Плейбой"],
    "pregnancy": ["Pregnancy", "Embarazo", "Gravidez", "Kehamilan", "Mang thai", "ตั้งครรภ์", "妊娠", "임신", "孕期", "حمل", "Grossesse", "Schwangerschaft", "Ciąża", "Těhotenství", "Беременность"],
    "princess": ["Princess", "Princesa", "Princesa", "Putri", "Công chúa", "เจ้าหญิง", "姫", "공주", "公主", "أميرة", "Princesse", "Prinzessin", "Księżniczka", "Princezna", "Принцесса"],
    "rebirth": ["Rebirth", "Renacimiento", "Renascimento", "Kelahiran kembali", "Trùng sinh", "เกิดใหม่", "転生", "환생", "重生", "ولادة من جديد", "Renaissance", "Wiedergeburt", "Odrodzenie", "Znovuzrození", "Перерождение"],
    "redemption": ["Redemption", "Redención", "Redenção", "Penebusan", "Chuộc tội", "การไถ่บาป", "贖罪", "구원", "救贖", "فداء", "Rédemption", "Erlösung", "Odkupienie", "Vykoupení", "Искупление"],
    "regret": ["Regret", "Arrepentimiento", "Arrependimento", "Penyesalan", "Hối hận", "ความเสียใจ", "後悔", "후회", "追悔", "ندم", "Regret", "Reue", "Żal", "Lítost", "Сожаление"],
    "rekindled-love": ["Rekindled Love", "Amor reavivado", "Amor reaceso", "Cinta yang menyala lagi", "Tái hợp", "รักที่หวนคืน", "よりを戻す恋", "재회한 사랑", "破鏡重圓", "حب متجدد", "Amour ravivé", "Wiederentfachte Liebe", "Odnowiona miłość", "Obnovená láska", "Возрождённая любовь"],
    "return-of-the-war-god": ["Return of the War God", "El regreso del dios de la guerra", "O retorno do deus da guerra", "Kembalinya dewa perang", "Chiến thần trở về", "เทพสงครามกลับมา", "戦神の帰還", "전신의 귀환", "戰神歸來", "عودة إله الحرب", "Retour du dieu de la guerre", "Rückkehr des Kriegsgotts", "Powrót boga wojny", "Návrat boha války", "Возвращение бога войны"],
    "revenge": ["Revenge", "Venganza", "Vingança", "Balas dendam", "Báo thù", "แก้แค้น", "復讐", "복수", "復仇", "انتقام", "Vengeance", "Rache", "Zemsta", "Pomsta", "Месть"],
    "romance": ["Romance", "Romance", "Romance", "Romansa", "Ngôn tình", "โรแมนซ์", "恋愛", "로맨스", "言情", "رومانسية", "Romance", "Romanze", "Romans", "Romance", "Романтика"],
    "royalty": ["Royalty", "Realeza", "Realeza", "Kerajaan", "Hoàng tộc", "ราชวงศ์", "王族", "왕실", "王室", "الملوكية", "Royauté", "Königshaus", "Rodzina królewska", "Královský rod", "Королевская семья"],
    "science-fiction": ["Science Fiction", "Ciencia ficción", "Ficção científica", "Fiksi ilmiah", "Khoa học viễn tưởng", "ไซไฟ", "SF", "SF", "科幻", "خيال علمي", "Science-fiction", "Science-Fiction", "Science fiction", "Sci-fi", "Научная фантастика"],
    "secret-baby": ["Secret Baby", "Bebé secreto", "Bebê secreto", "Bayi rahasia", "Em bé bí mật", "ทารกในความลับ", "秘密の赤ちゃん", "비밀의 아기", "隱秘萌寶", "طفل سري", "Bébé secret", "Geheimes Baby", "Sekretne dziecko", "Tajné dítě", "Тайный ребёнок"],
    "secretary": ["Secretary", "Secretaria", "Secretária", "Sekretaris", "Thư ký", "เลขานุการ", "秘書", "비서", "秘書", "سكرتيرة", "Secrétaire", "Sekretärin", "Sekretarka", "Sekretářka", "Секретарь"],
    "security-guard": ["Security Guard", "Guardia de seguridad", "Segurança", "Satpam", "Bảo vệ", "รปภ.", "警備員", "경비원", "保安", "حارس أمن", "Agent de sécurité", "Sicherheitsdienst", "Ochroniarz", "Ochranka", "Охранник"],
    "single-mom-escape": ["Single Mom Escape", "Huida de una madre soltera", "Fuga de uma mãe solteira", "Pelarian ibu tunggal", "Mẹ đơn thân bỏ trốn", "แม่เลี้ยงเดี่ยวหนี", "シングルマザーの逃走", "미혼모의 탈출", "帶娃逃離", "هروب أم عزباء", "Fuite d’une mère célibataire", "Flucht einer alleinerziehenden Mutter", "Ucieczka samotnej matki", "Útěk svobodné matky", "Побег матери-одиночки"],
    "single-mother": ["Single Mother", "Madre soltera", "Mãe solteira", "Ibu tunggal", "Mẹ đơn thân", "แม่เลี้ยงเดี่ยว", "シングルマザー", "미혼모", "單親媽媽", "أم عزباء", "Mère célibataire", "Alleinerziehende Mutter", "Samotna matka", "Svobodná matka", "Мать-одиночка"],
    "son-in-law-comeback": ["Son-in-Law Comeback", "El yerno contraataca", "O genro contra-ataca", "Kebangkitan menantu", "Con rể phản kích", "ลูกเขยพลิกเกม", "婿入り逆転", "사위의 역전", "贅婿逆襲", "عودة الصهر", "Le gendre contre-attaque", "Die Rückkehr des Schwiegersohns", "Comeback zięcia", "Návrat zetě", "Камбэк зятя"],
    "soul-swap": ["Soul Swap", "Intercambio de almas", "Troca de almas", "Tukar jiwa", "Đổi linh hồn", "สลับวิญญาณ", "魂の入れ替わり", "영혼 교체", "靈魂互換", "تبادل الأرواح", "Échange d’âmes", "Seelentausch", "Zamiana dusz", "Výměna duší", "Обмен душами"],
    "student": ["Student", "Estudiante", "Estudante", "Mahasiswa", "Học sinh", "นักเรียน", "学生", "학생", "學生", "طالب", "Étudiant", "Student", "Student", "Student", "Студент"],
    "substitute": ["Substitute", "Sustituto", "Substituto", "Pengganti", "Kẻ thế thân", "ตัวแทน", "身代わり", "대역", "替身", "بديل", "Remplaçant", "Ersatz", "Zastępstwo", "Náhradník", "Подмена"],
    "substitute-marriage": ["Substitute Marriage", "Matrimonio por sustitución", "Casamento por substituição", "Pernikahan pengganti", "Cưới thay", "แต่งงานแทน", "身代わり結婚", "대신 결혼", "替嫁", "زواج بديل", "Mariage par substitution", "Ersatzheirat", "Małżeństwo zastępcze", "Náhradní sňatek", "Брак по подмене"],
    "sudden-wealth": ["Sudden Wealth", "Riqueza repentina", "Riqueza súbita", "Kaya mendadak", "Phát tài bất ngờ", "รวยชั่วข้ามคืน", "成り上がり", "갑작스러운 부", "突然暴富", "ثروة مفاجئة", "Richesse soudaine", "Plötzlicher Reichtum", "Nagłe bogactwo", "Náhlé bohatství", "Внезапное богатство"],
    "supernatural": ["Supernatural", "Sobrenatural", "Sobrenatural", "Supranatural", "Siêu nhiên", "เหนือธรรมชาติ", "超常", "초자연", "靈異", "خارق للطبيعة", "Surnaturel", "Übernatürlich", "Nadprzyrodzone", "Nadpřirozeno", "Сверхъестественное"],
    "superpowers": ["Superpowers", "Superpoderes", "Superpoderes", "Kekuatan super", "Siêu năng lực", "พลังพิเศษ", "超能力", "초능력", "超能力", "قوى خارقة", "Super-pouvoirs", "Überkräfte", "Supermoce", "SuperSíly", "Суперсилы"],
    "suspense": ["Suspense", "Suspense", "Suspense", "Suspen", "Hồi hộp", "ระทึกขวัญ", "サスペンス", "서스펜스", "懸疑", "تشويق", "Suspense", "Spannung", "Sensacja", "Napínavka", "Саспенс"],
    "sweetness": ["Sweetness", "Dulzura", "Doçura", "Manis", "Ngọt ngào", "หวานชื่น", "甘々", "달달함", "甜寵", "حلاوة", "Douceur", "Süß", "Słodkość", "Sladkost", "Сладость"],
    "system-fantasy": ["System Fantasy", "Fantasía de sistema", "Fantasia de sistema", "Fantasi sistem", "Dòng hệ thống", "ระบบแฟนตาซี", "システムもの", "시스템물", "系統流", "فانتازيا النظام", "Fantasy à système", "System-Fantasy", "Fantastyka z systemem", "Systémová fantasy", "Системное фэнтези"],
    "tearjerker": ["Tearjerker", "Drama lacrimógeno", "Drama emocionante", "Mengharukan", "Cảm động", "ซึ้งน้ำตา", "泣ける話", "눈물 자극", "催淚", "مؤثر للدموع", "Histoire à larmes", "Tränendrüse", "Łzawer", "Doják", "Слезоточивая история"],
    "time-loop": ["Time Loop", "Bucle temporal", "Loop temporal", "Lingkaran waktu", "Vòng lặp thời gian", "วนเวลา", "タイムループ", "타임루프", "時間循環", "حلقة زمنية", "Boucle temporelle", "Zeitschleife", "Pętla czasu", "Časová smyčka", "Петля времени"],
    "time-travel": ["Time Travel", "Viaje en el tiempo", "Viagem no tempo", "Perjalanan waktu", "Du hành thời gian", "ย้อนเวลา", "タイムトラベル", "타임슬립", "穿越", "سفر عبر الزمن", "Voyage dans le temps", "Zeitreise", "Podróż w czasie", "Cestování časem", "Путешествие во времени"],
    "tragic-ending": ["Tragic Ending", "Final trágico", "Final trágico", "Ending tragis", "Kết thúc bi kịch", "จบแบบโศกนาฏกรรม", "バッドエンド", "비극적 결말", "悲劇結局", "نهاية مأساوية", "Fin tragique", "Tragisches Ende", "Tragiczne zakończenie", "Tragický konec", "Трагический финал"],
    "unrequited-love": ["Unrequited Love", "Amor no correspondido", "Amor não correspondido", "Cinta tak berbalas", "Yêu đơn phương", "รักข้างเดียว", "片想い", "짝사랑", "單戀", "حب من طرف واحد", "Amour non partagé", "Unerwiderte Liebe", "Niespełniona miłość", "Neopětovaná láska", "Безответная любовь"],
    "urban-hero": ["Urban Hero", "Héroe urbano", "Herói urbano", "Pahlawan kota", "Anh hùng đô thị", "ฮีโร่เมือง", "都市の英雄", "도시 영웅", "都市英雄", "بطل حضري", "Héros urbain", "Stadt-Held", "Miejski bohater", "Městský hrdina", "Городской герой"],
    "urban-setting": ["Urban Setting", "Ambientación urbana", "Cenário urbano", "Latar kota", "Bối cảnh đô thị", "ฉากในเมือง", "都市背景", "도시 배경", "都市背景", "خلفية حضرية", "Cadre urbain", "Großstadt-Schauplatz", "Miejskie realia", "Městské prostředí", "Городская обстановка"],
    "vampire": ["Vampire", "Vampiro", "Vampiro", "Vampir", "Ma cà rồng", "แวมไพร์", "ヴァンパイア", "뱀파이어", "吸血鬼", "مصاص دماء", "Vampire", "Vampir", "Wampir", "Upír", "Вампир"],
    "village-life": ["Village Life", "Vida rural", "Vida no campo", "Kehidupan desa", "Cuộc sống làng quê", "ชีวิตชนบท", "田舎暮らし", "시골 생활", "鄉村生活", "حياة القرية", "Vie de village", "Dorfleben", "Życie wiejskie", "Vesnický život", "Деревенская жизнь"],
    "warrior-protagonist": ["Warrior Protagonist", "Protagonista guerrero", "Protagonista guerreiro", "Protagonis pejuang", "Nhân vật chính chiến binh", "ตัวเอกนักรบ", "戦士の主人公", "전사 주인공", "戰士主角", "بطل محارب", "Protagoniste guerrier", "Krieger-Protagonist", "Wojownik jako protagonista", "Válečný protagonista", "Герой-воин"],
    "wealthy-ceo": ["Wealthy CEO", "CEO millonario", "CEO milionário", "CEO konglomerat", "Tổng tài giàu có", "ซีอีโอมหาเศรษฐี", "財閥CEO", "재벌 CEO", "豪門總裁", "رئيس تنفيذي ثري", "PDG fortuné", "Reicher CEO", "Bogaty prezes", "Bohatý CEO", "Богатый генеральный директор"],
    "werewolf": ["Werewolf", "Hombre lobo", "Lobisomem", "Manusia serigala", "Người sói", "มนุษย์หมาป่า", "人狼", "늑대인간", "狼人", "مستذئب", "Loup-garou", "Werwolf", "Wilkołak", "Vlkodlak", "Оборотень"],
    "werewolf-alpha": ["Werewolf Alpha", "Alfa hombre lobo", "Alfa lobisomem", "Alpha manusia serigala", "Alpha người sói", "อัลฟ่ามนุษย์หมาป่า", "人狼のアルファ", "늑대인간 알파", "Alpha（狼人首領）", "ألفا المستذئبين", "Alpha loup-garou", "Werwolf-Alpha", "Alfa wilkołaków", "Vlkodlačí alfa", "Альфа оборотней"],
    "werewolf-luna": ["Werewolf Luna", "Luna hombre lobo", "Luna lobisomem", "Luna manusia serigala", "Luna người sói", "ลูน่ามนุษย์หมาป่า", "人狼のルナ", "늑대인간 루나", "Luna（狼人女首領）", "لونا المستذئبين", "Luna loup-garou", "Werwolf-Luna", "Luna wilkołaków", "Vlkodlačí Luna", "Луна оборотней"],
    "western-fantasy": ["Western Fantasy", "Fantasía occidental", "Fantasia ocidental", "Fantasi barat", "Kỳ ảo phương Tây", "แฟนตาซีตะวันตก", "西洋ファンタジー", "서양 판타지", "西方奇幻", "فانتازيا غربية", "Fantasy occidentale", "Westliche Fantasy", "Fantastyka zachodnia", "Západní fantasy", "Западное фэнтези"],
    "whirlwind-marriage": ["Whirlwind Marriage", "Matrimonio relámpago", "Casamento relâmpago", "Pernikahan kilat", "Cưới vội", "แต่งงานรวดเร็ว", "電撃結婚", "번개 결혼", "閃婚", "زواج سريع", "Mariage éclair", "Blitzhochzeit", "Błyskawiczny ślub", "Bleskový sňatek", "Стремительный брак"],
    "win-back-the-husband": ["Win Back the Husband", "Recuperar al marido", "Reconquistar o marido", "Merebut kembali suami", "Giành lại chồng", "ทวงสามีคืน", "夫を取り戻す", "남편 되찾기", "挽回丈夫", "استعادة الزوج", "Reconquérir le mari", "Den Ehemann zurückgewinnen", "Odzyskać męża", "Získat manžela zpět", "Вернуть мужа"],
    "xianxia": ["Xianxia", "Xianxia", "Xianxia", "Xianxia", "Tiên hiệp", "เซียนเซีย", "仙侠", "선협", "仙俠修真", "شيانشيا", "Xianxia", "Xianxia", "Xianxia", "Xianxia", "Сянься"],
    "young-adult": ["Young Adult", "Juvenil", "Jovem adulto", "Remaja", "Thanh thiếu niên", "วัยรุ่น", "ヤングアダルト", "청소년", "青少年", "يافعون", "Young adult", "Jugendbuch", "Młodzieżowe", "Young adult", "Подростковое"],
}


def cps_root() -> Path | None:
    env = os.environ.get("CPS_READONLY_ROOT")
    return Path(env) if env else None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    v1_raw = V1_PATH.read_bytes()
    actual = sha256_bytes(v1_raw)
    if actual != V1_SHA:
        raise SystemExit(f"CanonicalTag v1 SHA mismatch: expected {V1_SHA}, got {actual}")
    v1 = json.loads(v1_raw.decode("utf-8"))
    tags = v1["tags"]
    if len(tags) != 123:
        raise SystemExit(f"expected 123 tags, got {len(tags)}")

    for slug, row in NEW_ROWS.items():
        if len(row) != 15:
            raise SystemExit(f"{slug} has {len(row)} labels, expected 15")
    missing = sorted({t["slug"] for t in tags} - set(NEW_ROWS))
    extra = sorted(set(NEW_ROWS) - {t["slug"] for t in tags})
    if missing or extra:
        raise SystemExit(f"NEW_ROWS mismatch missing={missing} extra={extra}")

    repair: dict[str, dict[str, str]] = {}
    de: dict[str, str] = {}
    pl: dict[str, str] = {}
    cs: dict[str, str] = {}
    root = cps_root()
    if root:
        v811 = root / "cps-admin-v811-search-ux"
        repair_path = v811 / "data/tags/tag-rule-names-repair-20260515.json"
        de_path = v811 / "data/taxonomy/de-category-tag-i18n.json"
        pl_path = v811 / "data/taxonomy/pl-category-tag-i18n.json"
        cs_path = v811 / "data/taxonomy/cs-category-tag-i18n.json"
        if repair_path.exists():
            repair = {r["slug"]: r["names"] for r in load_json(repair_path)["repairs"]}
        if de_path.exists():
            for tag in load_json(de_path)["tags"]:
                if tag.get("needsReview"):
                    continue
                name = (tag.get("proposedDe") or tag.get("deName") or "").strip()
                if name:
                    de[tag["slug"]] = name
        if pl_path.exists():
            for tag in load_json(pl_path)["tags"]:
                name = (tag.get("plName") or "").strip()
                if name:
                    pl[tag["slug"]] = name
        if cs_path.exists():
            for tag in load_json(cs_path)["tags"]:
                # Display names only. csKeywords are classifier tokens, not labels.
                name = (tag.get("csName") or "").strip()
                if name:
                    cs[tag["slug"]] = name

    KEEP_AUTHORED = {
        "werewolf-alpha",
        "werewolf-luna",
        "wealthy-ceo",
        "female-audience",
        "male-audience",
        "mature-content",
        "child-centered-romance",
        "secret-baby",
        "older-adult-romance",
        "cross-dressing",
        "frenemies",
    }
    # CPS display name collides with another CanonicalTag in that locale.
    FORCE_NEW = {("historical-romance", "de")}

    translations = []
    for tag in tags:
        slug = tag["slug"]
        stable_id = tag["stable_id"]
        zh = tag["display_name_zh"]
        new_by_locale = dict(zip(SITE_LOCALES, NEW_ROWS[slug]))
        if slug in repair or slug in de or slug in pl or slug in cs:
            source_slug = slug
            semantic = False
        else:
            source_slug = SEMANTIC_MAP.get(slug)
            semantic = bool(source_slug)
        repair_names = repair.get(source_slug) if source_slug else None
        reuse_status = "adapted" if semantic else "reviewed"

        for locale in SITE_LOCALES:
            display = new_by_locale[locale]
            source = "new"
            source_locale = locale
            review_status = "new"

            def stamp(value: str, src: str, src_locale: str, status: str) -> None:
                nonlocal display, source, source_locale, review_status
                cleaned = value.strip()
                if not cleaned:
                    return
                display = cleaned
                source = src
                source_locale = src_locale
                review_status = status

            reuse_kind = "reuse_cps_semantic_map" if semantic else "reuse_cps_exact_slug"
            allow_cps = slug not in KEEP_AUTHORED

            if allow_cps and locale == "de" and source_slug and de.get(source_slug):
                stamp(de[source_slug], reuse_kind, "de", reuse_status)
            elif allow_cps and locale == "pl" and source_slug and pl.get(source_slug):
                stamp(pl[source_slug], reuse_kind, "pl", reuse_status)
            elif allow_cps and locale == "cs" and source_slug and cs.get(source_slug):
                stamp(cs[source_slug], reuse_kind, "cs", reuse_status)

            if allow_cps and repair_names:
                repair_value = (repair_names.get(locale) or "").strip()
                if repair_value:
                    stamp(repair_value, "reuse_repair", locale, reuse_status)

            if locale == "zh-Hant" and display == zh:
                stamp(new_by_locale[locale], "new", "zh-Hant", "new")

            if (slug, locale) in FORCE_NEW:
                stamp(new_by_locale[locale], "new", locale, "new")

            item = {
                "stableId": stable_id,
                "slug": slug,
                "locale": locale,
                "displayName": display,
                "source": source,
                "sourceLocale": source_locale,
                "reviewStatus": review_status,
            }
            if semantic and source.startswith("reuse"):
                item["sourceSlug"] = source_slug
            translations.append(item)

    translations.sort(key=lambda row: (row["slug"], SITE_LOCALES.index(row["locale"])))
    if len(translations) != 123 * 15:
        raise SystemExit(f"expected {123*15} translations, got {len(translations)}")

    locales_used = {row["locale"] for row in translations}
    if locales_used != set(SITE_LOCALES):
        raise SystemExit(f"locale set mismatch {sorted(locales_used)}")
    if any(row["locale"] == "zh" for row in translations):
        raise SystemExit("overlay must not include zh rows")

    artifact = {
        "schema_version": 1,
        "artifact_status": "SEMANTIC_CHECKED",
        "taxonomy_version": "canonical-tag-v1",
        "canonical_v1_sha256": V1_SHA,
        "canonical_v1_count": 123,
        "public_locales": SITE_LOCALES,
        "translation_count": len(translations),
        "overwrite_zh": False,
        "review_scope": (
            "Meaning check against CanonicalTag display_name_zh for wrong sense, "
            "clear ambiguity, and concept mix-up. Not a full linguistic sign-off of every cell."
        ),
        "cache_note": (
            "Public taxonomy queries are force-dynamic with request-scoped React.cache(); "
            "overlay apply is visible on the next request without restart or waiting for "
            "getActiveLocales 300s TTL. getActiveLocales does not cache tag labels."
        ),
        "translations": translations,
    }
    text = json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(text, encoding="utf-8")
    digest = sha256_bytes(text.encode("utf-8"))
    OUT_SHA.write_text(digest + "\n", encoding="utf-8")
    by_source: dict[str, int] = {}
    by_review: dict[str, int] = {}
    for row in translations:
        by_source[row["source"]] = by_source.get(row["source"], 0) + 1
        by_review[row["reviewStatus"]] = by_review.get(row["reviewStatus"], 0) + 1
    print(json.dumps({
        "path": str(OUT_JSON),
        "sha256": digest,
        "count": len(translations),
        "unit": "CanonicalTag x SITE_LOCALE displayName cell",
        "by_source": by_source,
        "by_reviewStatus": by_review,
    }, indent=2))


if __name__ == "__main__":
    main()
