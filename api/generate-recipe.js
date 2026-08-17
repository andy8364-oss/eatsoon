/* ============================================================
   POST /api/generate-recipe  { ingredientName }
   1) Supabase recipe_cache에서 먼저 조회
   2) 없으면 LLM으로 새로 생성 후 캐시에 저장
   3) { recipe, cached } 반환

   필요한 환경변수 (Vercel 프로젝트 Settings > Environment Variables):
   - SUPABASE_URL
   - SUPABASE_ANON_KEY
   - GEMINI_API_KEY   (Google AI Studio, 무료 티어)
   ============================================================ */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.6-flash';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !GEMINI_API_KEY) {
    res.status(500).json({ error: '서버 환경변수(SUPABASE_URL/SUPABASE_ANON_KEY/GEMINI_API_KEY)가 설정되지 않았습니다.' });
    return;
  }

  const { ingredientName } = req.body || {};
  if (!ingredientName || typeof ingredientName !== 'string' || !ingredientName.trim()) {
    res.status(400).json({ error: 'ingredientName이 필요합니다.' });
    return;
  }
  const name = ingredientName.trim().slice(0, 30);

  try {
    const cached = await getCachedRecipe(name);
    if (cached) {
      res.status(200).json({ recipe: cached, cached: true });
      return;
    }

    const recipe = await generateRecipeWithLLM(name);
    await saveCachedRecipe(name, recipe);
    res.status(200).json({ recipe, cached: false });
  } catch (err) {
    console.error('generate-recipe error:', err);
    res.status(500).json({ error: '레시피 생성에 실패했습니다.', detail: String(err && err.message || err) });
  }
};

async function getCachedRecipe(name) {
  const url = `${SUPABASE_URL}/rest/v1/recipe_cache?ingredient_name=eq.${encodeURIComponent(name)}&select=recipe&limit=1`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
  if (!r.ok) throw new Error(`Supabase 조회 실패 (${r.status})`);
  const rows = await r.json();
  return (rows && rows[0] && rows[0].recipe) || null;
}

async function saveCachedRecipe(name, recipe) {
  const url = `${SUPABASE_URL}/rest/v1/recipe_cache`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates'
    },
    body: JSON.stringify({ ingredient_name: name, recipe })
  });
  if (!r.ok && r.status !== 409) {
    console.error('Supabase insert failed:', r.status, await r.text().catch(() => ''));
  }
}

async function generateRecipeWithLLM(name) {
  const prompt = `당신은 자취생을 위한 초간단 레시피를 만드는 요리 도우미입니다.
재료 "${name}"를 활용한 한국식 자취 요리 레시피를 1개 만들어주세요.

반드시 아래 JSON 형식으로만 답하세요. 다른 설명 텍스트는 절대 포함하지 마세요.
{
  "title": "요리 이름 (한글, 15자 이내)",
  "emoji": "요리를 표현하는 이모지 1개",
  "minutes": 조리 소요 시간(숫자, 3~20 사이),
  "tags": ["핵심 재료명 2~4개, 한글 표준 명칭"],
  "ingredients": ["재료명과 분량을 함께 적은 문자열 목록 (3~6개)"],
  "steps": ["조리 순서를 짧은 문장으로 (2~4단계)"]
}

"${name}"는 tags 배열에 반드시 포함하세요.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 700,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`LLM 호출 실패 (${r.status}): ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM 응답에서 JSON을 찾지 못했습니다.');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.title || !Array.isArray(parsed.tags) || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error('LLM 응답 형식이 올바르지 않습니다.');
  }

  return {
    title: String(parsed.title).slice(0, 30),
    emoji: parsed.emoji || '🍽️',
    minutes: Number(parsed.minutes) || 10,
    tags: parsed.tags.slice(0, 6).map(String),
    ingredients: parsed.ingredients.slice(0, 8).map(String),
    steps: parsed.steps.slice(0, 6).map(String)
  };
}
