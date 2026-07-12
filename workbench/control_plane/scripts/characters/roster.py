#!/usr/bin/env python3
"""The character LIBRARY roster — a reusable bank of diverse office characters that
can later be assigned to AI agents (or people). Ordered by PRIORITY: breadth first
(a male + a female of every core company role), then attire/accessory variety
(beanies, hoodies, suits with headphones / earphones / headsets). The generation
campaign walks this list top-to-bottom and stops when Pixel Lab credits run out, so
the most important coverage is generated first.

Each entry: (id, gender, role, description). Keep ids short + kebab-case.
"""

STYLE = "cute pixel art RPG character, front view, friendly, clean outline"

# (id, gender, role, description)  — description is appended with STYLE at gen time.
ROSTER = [
    # ---- Wave 1: breadth — male + female of each core company role ----
    ("exec-f", "female", "executive",
     "a confident female executive in a charcoal business suit with a silk blouse, "
     "gold stud earrings, sleek black hair in a low bun, warm brown skin"),
    ("exec-m", "male", "executive",
     "a confident male CEO in a navy three-piece suit and tie, silver wristwatch, "
     "neat salt-and-pepper hair, light skin"),
    ("engineer-f", "female", "engineer",
     "a female software engineer in a grey zip hoodie wearing over-ear headphones, "
     "curly auburn hair, fair freckled skin"),
    ("engineer-m", "male", "engineer",
     "a male software developer in a black hoodie with a slim headset mic, dark-framed "
     "glasses, short black hair, medium brown skin"),
    ("designer-f", "female", "designer",
     "a female product designer in a mustard beanie and denim jacket, small wireless "
     "earbuds, teal-dyed shoulder-length hair, olive skin"),
    ("designer-m", "male", "designer",
     "a male UX designer in a cream knit sweater, round glasses, tidy blond hair, "
     "fair skin"),
    ("sales-f", "female", "sales",
     "a female sales lead in a burgundy blazer over a white top, small hoop earrings, "
     "straight shoulder-length brown hair, tan skin"),
    ("sales-m", "male", "sales",
     "a male salesperson in a light-blue dress shirt and navy tie with a bluetooth "
     "earpiece, neat black hair, dark brown skin"),
    ("marketing-f", "female", "marketing",
     "a female marketer in a coral blouse and cream cardigan, a colorful patterned "
     "headscarf, warm medium-brown skin"),
    ("marketing-m", "male", "marketing",
     "a male marketing manager in a teal polo shirt, trendy undercut hairstyle, "
     "light-brown skin"),
    ("finance-f", "female", "finance",
     "a female accountant in a grey waistcoat over a white blouse, thin-rimmed "
     "glasses, brown hair in a low ponytail, fair skin"),
    ("finance-m", "male", "finance",
     "a male finance analyst in a dark-blue dress shirt and tie holding a calculator, "
     "short neat brown hair, olive skin"),
    ("hr-f", "female", "hr",
     "a friendly female HR manager in a soft-green blazer, shoulder-length wavy "
     "chestnut hair, medium skin"),
    ("hr-m", "male", "hr",
     "a warm male HR coordinator in a beige cardigan over a collared shirt, short "
     "curly black hair, dark skin"),
    ("ops-f", "female", "operations",
     "a female operations lead in an orange utility vest over a shirt and a cap, "
     "brown ponytail, tan skin"),
    ("ops-m", "male", "operations",
     "a male operations coordinator in a khaki work shirt with a headset, buzz-cut "
     "hair, medium brown skin"),
    ("product-f", "female", "product",
     "a female product manager in a maroon turtleneck holding a tablet, dark bob "
     "haircut, light skin"),
    ("product-m", "male", "product",
     "a male product manager in a slate button-down shirt with a lanyard badge, "
     "glasses, short dark hair, olive skin"),
    ("data-f", "female", "data",
     "a female data scientist in a purple hoodie wearing over-ear headphones, "
     "glasses, black hair in a high bun, brown skin"),
    ("data-m", "male", "data",
     "a male data analyst in a green flannel shirt with wired earphones, messy "
     "light-brown hair, fair skin"),
    ("legal-f", "female", "legal",
     "a female legal counsel in a black pantsuit, pearl earrings, straight dark "
     "bob, medium skin"),
    ("legal-m", "male", "legal",
     "a male compliance officer in a dark-grey suit and glasses, neat side-part "
     "brown hair, light skin"),
    ("support-f", "female", "support",
     "a cheerful female support agent in a bright coral hoodie with a headset mic, "
     "side ponytail, tan skin"),
    ("support-m", "male", "support",
     "a male customer support rep in a teal t-shirt with a headset, short afro, "
     "dark brown skin"),
    # ---- Wave 2: attire / accessory variety highlights ----
    ("beanie-dev-f", "female", "engineer",
     "a female indie developer in a chunky knit beanie and an oversized hoodie, "
     "wireless earbuds, freckles, pale skin"),
    ("hoodie-gamer-m", "male", "engineer",
     "a male gamer-developer in a red gaming hoodie and a large RGB gaming headset, "
     "undercut hair, olive skin"),
    ("suit-headset-f", "female", "operations",
     "a female executive assistant in a tailored white suit with a slim call-center "
     "headset, sleek dark ponytail, dark skin"),
    ("suit-earphone-m", "male", "consultant",
     "a male consultant in a sharp black suit with white wired earphones, clean "
     "fade haircut, brown skin"),
]
