const $ = (id) => document.getElementById(id);
let currentRequest;
$('patient').addEventListener('change', () => {
  currentRequest?.abort();
  $('result').hidden = true;
});
$('ask').addEventListener('submit', async (event) => {
  event.preventDefault();
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  $('submit').disabled = true;
  $('result').hidden = false;
  $('answer').textContent = '답변을 작성하고 있습니다…';
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      signal: request.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientId: $('patient').value, question: $('question').value.trim() }),
    });
    const data = await response.json();
    if (!request.signal.aborted)
      $('answer').textContent = data.answer || data.message || '요청을 처리할 수 없습니다.';
  } catch {
    if (!request.signal.aborted)
      $('answer').textContent = '서버 연결을 확인한 뒤 다시 질문해 주세요.';
  } finally {
    if (currentRequest === request) $('submit').disabled = false;
  }
});
