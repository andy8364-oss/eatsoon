/* ============================================================
   POST /api/scan-expiry  { imageBase64, mimeType }
   포장지/라벨 사진에서 식재료명과 소비기한을 추출합니다.
   사진은 저장하지 않고 그 자리에서 파싱만 합니다 (로그인/DB 불필요).

   필요한 환경변수: GEMINI_API_KEY (generate-recipe.js와 동일 키 재사용)
   ============================================================ */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.6-flash';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST 요청만 지원합니다.' });
    return;
  }
  if (!GEMINI_API_KEY) {
    res.status(500).json({ error: '서버 환경변수(GEMINI_API_KEY)가 설정되지 않았습니다.' });
    return;
  }

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64가 필요합니다.' });
    return;
  }

  try {
    const result = await scanWithGemini(imageBase64, mimeType || 'image/jpeg');
    res.status(200).json({ result });
  } catch (err) {
    console.error('scan-expiry error:', err);
    res.status(500).json({ error: '사진 인식에 실패했습니다.', detail: String(err && err.message || err) });
  }
};

async function scanWithGemini(imageBase64, mimeType) {
  const prompt = `이 사진은 식품 포장지, 라벨, 또는 영수증입니다.
다음 정보를 JSON으로만 답하세요. 다른 설명은 절대 포함하지 마세요.
{
  "name": "식재료명 (한글, 간결하게, 예: 우유, 계란, 두부). 확실하지 않으면 null",
  "expiry": "소비기한 또는 유통기한을 YYYY-MM-DD 형식으로. 사진에 2026.08.20, 20260820, 26/08/20 등 다양한 형식으로 적혀있을 수 있으니 정규화해서 반환하세요. 날짜를 못 찾으면 null"
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': GEMINI_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500,
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
  if (!jsonMatch) {
    const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`인식 결과에서 JSON을 찾지 못했습니다. finishReason=${finishReason}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);

  const name = parsed.name && typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 20) : null;
  const expiry = typeof parsed.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.expiry) ? parsed.expiry : null;

  return { name, expiry };
}
