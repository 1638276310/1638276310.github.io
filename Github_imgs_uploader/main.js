/* ========== 工具函数 ========== */
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

/* ========== 配置单例 ========== */
const config = {
  data: JSON.parse(localStorage.getItem('ghConfig')||'{}'),
  set(k,v){
    this.data[k]=v.trim();
    localStorage.setItem('ghConfig',JSON.stringify(this.data));
  }
};

/* ========== 初始化输入框 & 压缩开关 ========== */
['token','user','repo','branch'].forEach(k=>{
  if(config.data[k]) $(`#${k}`).value=config.data[k];
  $(`#${k}`).addEventListener('change',e=>config.set(k,e.target.value));
});
// 记住压缩勾选状态
const doCompressEl = $('#doCompress');
const COMPRESS_KEY = 'gh_doCompress';
doCompressEl.checked = localStorage.getItem(COMPRESS_KEY)==='true';
doCompressEl.addEventListener('change',()=>localStorage.setItem(COMPRESS_KEY,doCompressEl.checked));

/* ========== 拖拽 / 选择 ========== */
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
['dragenter','dragover','dragleave','drop'].forEach(evt=>{
  dropZone.addEventListener(evt, e=>{e.preventDefault();e.stopPropagation();});
});
['dragenter','dragover'].forEach(evt=>{
  dropZone.addEventListener(evt,()=>dropZone.classList.add('dragover'));
});
['dragleave','drop'].forEach(evt=>{
  dropZone.addEventListener(evt,()=>dropZone.classList.remove('dragover'));
});
dropZone.addEventListener('drop', e=>handleFiles(e.dataTransfer.files));
dropZone.addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',e=>handleFiles(e.target.files));

/* ========== 并发控制 ========== */
function pLimit(max){
  let queue=[];
  let active=0;
  const next=()=>{
    if(queue.length===0) return;
    const {fn,resolve,reject}=queue.shift();
    active++;
    Promise.resolve(fn()).then(resolve,reject).finally(()=>{
      active--;
      next();
    });
  };
  return fn=>new Promise((res,rej)=>{
    queue.push({fn,resolve:res,reject:rej});
    if(active<max) next();
  });
}
const limit = pLimit(3);

/* ========== 压缩（可选） ========== */
async function maybeCompress(file){
  if(!doCompressEl.checked) return file;
  const opt = { maxWidthOrHeight: 1440, useWebWorker: true, maxIteration: 6, fileType: file.type };
  return await imageCompression(file, opt);
}

/* ========== ImageTask 类 ========== */
class ImageTask {
  constructor(file){
    this.file = file;
    this.status = 'pending';
    this.url  = null;
    this.dom  = this.render();
    this.retryCount = 0;
  }
  render(){
    const div = document.createElement('div'); div.className='item';
    const img = document.createElement('img');
    const center = document.createElement('div'); center.className='item-center';
    const name = document.createElement('div'); name.className='name';
    const size = document.createElement('div'); size.className='size';
    const status = document.createElement('div'); status.className='item-status';
    const urlBox = document.createElement('div'); urlBox.className='item-url';
    const retryBtn = document.createElement('span'); retryBtn.className='item-action'; retryBtn.textContent='重试'; retryBtn.style.display='none';
    retryBtn.addEventListener('click',()=>this.start());

    center.append(name, size);
    div.append(img, center, urlBox, status, retryBtn);

    name.textContent = this.file.name;
    size.textContent = formatSize(this.file.size);
    status.textContent = '等待上传…';

    const reader = new FileReader();
    reader.onload = e => img.src = e.target.result;
    reader.readAsDataURL(this.file);

    this.statusEl=status; this.urlBox=urlBox; this.retryBtn=retryBtn;
    return div;
  }
  async start(){
    if(this.status==='success') return;
    const {token,user,repo,branch}=config.data;
    if(!token||!user||!repo||!branch){
      this.setStatus('❌ 请先填写配置','error'); return;
    }
    this.setStatus('上传中…','');
    const file = await maybeCompress(this.file);   // 关键：可选压缩
    const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    const hash = await sha256(file);
    const fileName = hash + ext;

    try{
      // 秒传检查
      const checkUrl = `https://api.github.com/repos/${user}/${repo}/contents/${fileName}?ref=${branch}`;
      const checkRes = await fetch(checkUrl,{method:'HEAD',headers:{'Authorization':`token ${token}`}});
      if(checkRes.ok){
        const raw = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${fileName}`;
        this.finish(`https://ghfast.top/${raw}`);
        return;
      }

      const content = await fileToBase64(file);
      const body = JSON.stringify({ message:`upload ${fileName} (by gh-uploader)`, content, branch });
      const url = `https://api.github.com/repos/${user}/${repo}/contents/${fileName}`;
      const r = await fetch(url,{method:'PUT',headers:{'Authorization':`token ${token}`,'Content-Type':'application/json'},body});
      if(!r.ok){
        const txt = await r.text();
        if(r.status===401) throw new Error('Token 无效');
        if(r.status===422 && txt.includes('sha')) throw new Error('文件已存在');
        throw new Error(txt);
      }
      const rawUrl = `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${fileName}`;
      this.finish(`https://ghfast.top/${rawUrl}`);
    }catch(e){
      console.error(e);
      if(this.retryCount<2){
        this.retryCount++;
        this.setStatus(`第 ${this.retryCount} 次重试…`,'');
        await sleep(1000*this.retryCount);
        return this.start();
      }
      this.setStatus('❌ '+e.message,'error');
      this.retryBtn.style.display='inline';
    }
  }
  finish(fastUrl){
    this.status='success';
    this.setStatus('✅ 成功','success');
    this.urlBox.innerHTML = `<a href="${fastUrl}" target="_blank">${fastUrl}</a>`;
    this.url = fastUrl;
    tasks.push({name:this.file.name, url:fastUrl});
    copyAll.style.display='flex';
  }
  setStatus(text,cls){
    this.statusEl.textContent = text;
    this.statusEl.className = 'item-status' + (cls?' '+cls:'');
  }
}

/* ========== 批量任务池 ========== */
const listBox = $('#list');
const copyAll = $('#copyAll');
const tasks = [];

async function handleFiles(files){
  const arr = Array.from(files).filter(f=>f.type.startsWith('image/'));
  arr.forEach(f=>limit(()=>{
    const t = new ImageTask(f);
    listBox.appendChild(t.dom);
    return t.start();
  }));
}

/* ========== 复制 ========== */
function copyList(type){
  let text='';
  if(type==='md')   text = tasks.map(t=>`![${t.name}](${t.url})`).join('\n');
  else if(type==='html') text = tasks.map(t=>`<img src="${t.url}" alt="${t.name}" />`).join('\n');
  else                    text = tasks.map(t=>t.url).join('\n');
  navigator.clipboard.writeText(text);
  alert('已复制到剪贴板！');
}

/* ========== base64 辅助 ========== */
function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.readAsDataURL(file);
    r.onload=()=>res(r.result.split(',')[1]);
    r.onerror=rej;
  });
}
