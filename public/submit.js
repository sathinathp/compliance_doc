'use strict';

const token = location.pathname.split('/').pop();
const endpoint = '/api/submit/' + encodeURIComponent(token);
const title = document.getElementById('request-title');
const info = document.getElementById('request-info');
const retry = document.getElementById('reload');
const form = document.getElementById('upload-form');
const input = document.getElementById('file');
const error = document.getElementById('upload-error');
const submit = form.querySelector('[type="submit"]');

function showError(message) {
  error.hidden = !message;
  error.textContent = message;
}

function showUnavailable(message) {
  form.hidden = true;
  title.textContent = 'Request unavailable';
  info.textContent = message;
}

async function loadRequest() {
  retry.hidden = true;
  info.textContent = 'Loading your request…';
  try {
    const response = await fetch(endpoint, { cache: 'no-store' });
    const request = await response.json();
    if (!response.ok) {
      showUnavailable(request.error || 'This request could not be opened.');
      retry.hidden = response.status === 410;
      return;
    }
    title.textContent = request.document;
    info.textContent = 'Requested for ' + request.first_name +
      (request.due ? ' · Due ' + request.due : '');
    form.hidden = false;
  } catch {
    showUnavailable('Check your connection and try again.');
    retry.hidden = false;
  }
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reader.onabort = () => reject(new Error('The file could not be read. Choose it again and retry.'));
    reader.readAsDataURL(file);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  const file = input.files[0];
  if (!file) return;
  if (file.size === 0 || file.size > 10 * 1024 * 1024) {
    showError(file.size === 0 ? 'This file is empty. Choose another document.' : 'Choose a file of 10 MB or less.');
    return;
  }
  showError('');
  submit.disabled = true;
  input.disabled = true;
  submit.textContent = 'Uploading…';
  try {
    const data = await readFile(file);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: { name: file.name, mime: file.type, data } }),
    });
    const result = await response.json();
    if (response.status === 410 || response.status === 429) {
      showUnavailable(result.error || 'Contact your coordinator about this request.');
    } else if (!response.ok) {
      showError(result.error || 'The upload could not be confirmed. Please retry.');
    } else {
      form.hidden = true;
      title.textContent = 'Document received';
      info.textContent = result.status;
      form.reset();
    }
  } catch (reason) {
    showError(reason.message?.startsWith('The file could not be read') ? reason.message : 'The upload could not be confirmed. Check your connection and retry.');
  } finally {
    submit.disabled = false;
    input.disabled = false;
    submit.textContent = 'Upload document';
  }
});

input.addEventListener('change', () => showError(''));
retry.addEventListener('click', loadRequest);
loadRequest();
