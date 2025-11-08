/* ==================== 工具 ==================== */
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sha256(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0,16);
}
function formatSize(b) {
  if(b<1024) return b+' B';
  if(b<1048576) return (b/1024).toFixed(1)+' KB';
  return (b/1048576).toFixed(1)+' MB';
}
function nowDate() { return new Date().toISOString().slice(0,10); }

/* ==================== 配置 ==================== */
const CONFIG_KEYS = ['token','user','repo','branch','folder','message'];
let CONFIG = JSON.parse(localStorage.getItem('ghConfig')||'{}');
CONFIG_KEYS.forEach(k=> { if(CONFIG[k]) $(`#${k}`).value = CONFIG[k]; });
CONFIG_KEYS.forEach(k=>{
  $(`#${k}`).addEventListener('input', e=>{
    CONFIG[k] = e.target.value.trim();
    localStorage.setItem('ghConfig', JSON.stringify(CONFIG));
  });
});

/* ==================== 拖拽 / 选择 ==================== */
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
['dragenter','dragover','dragleave','drop'].forEach(evt=>{
  dropZone.addEventListener(evt, e=>{e.preventDefault();e.stopPropagation();});
});
['dragenter','dragover'].forEach(evt=>{
  dropZone.addEventListener(evt, ()=> dropZone.classList.add('dragover'));
});
['dragleave','drop'].forEach(evt=>{
  dropZone.addEventListener(evt, ()=> dropZone.classList.remove('dragover'));
});
dropZone.addEventListener('drop', e=> handleFiles(e.dataTransfer.files));
dropZone.addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', e=> handleFiles(e.target.files));

/* ==================== 上传主流程 ==================== */
const listBox = $('#list');
const copyBox = $('#copyAll');
let tasks = [];   // {name,url}

async function handleFiles(files){
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
    const item = createItem(f);
    listBox.appendChild(item.dom);
    await upload(item);
  }
  if(tasks.length) copyBox.style.display='flex';
}

function createItem(file){
  const div = document.createElement('div'); div.className = 'item';
  const img = document.createElement('img');
  const info = document.createElement('div'); info.className = 'item-info';
  const name = document.createElement('div'); name.className = 'name';
  const size = document.createElement('div'); size.className = 'size';
  const status = document.createElement('div'); status.className = 'item-status';
  const urlBox = document.createElement('div'); urlBox.className = 'item-url';
  const retryBtn = document.createElement('span'); retryBtn.className = 'item-action'; retryBtn.textContent = '重试'; retryBtn.style.display = 'none';

  info.appendChild(name); info.appendChild(size);
  div.appendChild(img); div.appendChild(info); div.appendChild(status); div.appendChild(retryBtn); div.appendChild(urlBox);

  name.textContent = file.name;
  size.textContent = formatSize(file.size);
  status.textContent = '等待上传…';

  const reader = new FileReader();
  reader.onload = e => img.src = e.target.result;
  reader.readAsDataURL(file);

  return {file, dom:div, status, urlBox, retryBtn};
}

async function upload({file, dom, status, urlBox, retryBtn}){
  const {token, user, repo, branch, folder, message} = CONFIG;
  if(!token||!user||!repo||!branch){
    status.textContent = '❌ 请先填写配置'; status.classList.add('error'); return;
  }
  status.textContent = '上传中…'; status.classList.remove('success','error'); retryBtn.style.display = 'none';

  try{
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    const hash = await sha256(file);
    const fileName = hash + ext;

    const date = nowDate();
    const folderPath = (folder||'').replace('${date}', date);
    const pathKey = folderPath.replace(/^\//,'').replace(/\/$/,'') + (folderPath ? '/' : '') + fileName;

    const commitMsg = (message||'upload ${fileName}')
                      .replace('${fileName}', fileName)
                      .replace('${user}', user)
                      .replace('${date}', date);

    const content = await fileToBase64(file);
    const body = JSON.stringify({
      message: commitMsg,
      content: content,
      branch
    });

    const url = `https://api.github.com/repos/${user}/${repo}/contents/${pathKey}`;
    const r = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json'
      },
      body
    });
    if(!r.ok) throw new Error(await r.text());

    const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${pathKey}`;
    status.textContent = '✅ 成功'; status.classList.add('success');
    urlBox.innerHTML = `<a href="${rawUrl}" target="_blank">${rawUrl}</a>`;
    tasks.push({name: file.name, url: rawUrl});
  }catch(e){
    console.error(e);
    status.textContent = '❌ 失败'; status.classList.add('error');
    retryBtn.style.display = 'inline';
    retryBtn.onclick = ()=> upload({file, dom, status, urlBox, retryBtn});
  }
}

function fileToBase64(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = err => reject(err);
  });
}

/* ==================== 批量复制 ==================== */
copyBox.addEventListener('click', e=>{
  if(e.target.tagName!=='BUTTON') return;
  const type = e.target.dataset.type;
  let text='';
  if(type==='md')      text = tasks.map(t=>`![${t.name}](${t.url})`).join('\n');
  else if(type==='html') text = tasks.map(t=>`<img src="${t.url}" alt="${t.name}" />`).join('\n');
  else                 text = tasks.map(t=>t.url).join('\n');
  navigator.clipboard.writeText(text);
  alert('已复制到剪贴板！');
});
