// ==================== 数据存储层（MantleDB 云端同步 + localStorage 缓存） ====================
// 使用 MantleDB 作为云端 JSON 存储，支持跨电脑同步
// localStorage 优先加载（避免云端延迟），修改后同步到云端
const STORAGE_KEY = 'team_workbench_user';
const LOCAL_DATA_KEY = 'team_workbench_local_data';
const CLOUD_BASE = 'https://mantledb.sh/v2/team-workbench-v2';
const CLOUD_DATA_PATH = CLOUD_BASE + '/data';

// 带缓存清除的 fetch 封装：每次请求附加时间戳，避免浏览器缓存
function apiFetch(url, options = {}) {
  const sep = url.includes('?') ? '&' : '?';
  const cacheBustUrl = url + sep + '_t=' + Date.now();
  return fetch(cacheBustUrl, {
    ...options,
    cache: 'no-store',
    headers: {
      ...(options.headers || {}),
    },
  });
}

// localStorage 缓存读写
function loadLocalData() {
  try {
    var raw = localStorage.getItem(LOCAL_DATA_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.tasks && parsed.members && parsed.clients) {
        return parsed;
      }
    }
  } catch (e) { console.warn('读取本地缓存失败:', e); }
  return null;
}

function saveLocalDataCache(d) {
  try {
    var toSave = {
      tasks: d.tasks || [],
      members: d.members || [],
      clients: d.clients || [],
      permissions: d.permissions || {},
      notifications: d.notifications || [],
      collapsedClients: d.collapsedClients || [],
    };
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(toSave));
  } catch (e) { console.warn('保存本地缓存失败:', e); }
}

// 当前用户身份保存在 localStorage（每人独立）
function getCurrentUserId() {
  return localStorage.getItem(STORAGE_KEY) || null;
}

function setCurrentUserId(id) {
  localStorage.setItem(STORAGE_KEY, id);
}

let data = null;
let lastSyncTime = 0;
let isSaving = false;
let serverDataLoaded = false; // 标记是否已成功从服务器加载过数据
let saveTimer = null; // 保存防抖计时器
let deletedTaskIds = new Set(); // 跟踪本地删除的任务ID，防止合并时从服务器恢复
let selectedTaskIds = new Set(); // 批量选择的任务ID

// 统一数据迁移函数
function normalizeData(d) {
  if (!d.tasks) d.tasks = [];
  d.tasks.forEach(t => {
    if (['expected', 'overdue-done', 'review'].includes(t.status)) t.status = 'in-progress';
    // 迁移：firstViewedAt (单一时间戳) -> firstViewedBy (按用户记录)
    if (t.firstViewedBy === undefined) {
      if (t.firstViewedAt) {
        // 旧数据：所有受让人都算已查看过
        t.firstViewedBy = {};
        if (t.assignees) {
          t.assignees.forEach(function(aid) { t.firstViewedBy[aid] = t.firstViewedAt; });
        }
      } else {
        t.firstViewedBy = {};
      }
    }
    delete t.firstViewedAt;
    if (!t.segment) t.segment = '';
    if (!t.progress) t.progress = t.desc || '';
    if (!t.completedDate) t.completedDate = '';
    if (!t.commentReadBy) t.commentReadBy = {};
    if (!t.history) t.history = [];
    delete t.desc; delete t.priority;
  });
  if (!d.clients) d.clients = [];
  // 迁移：旧 Merit 名称 -> 长春Merit
  d.clients.forEach(function(c) {
    if (c.name === 'Merit') c.name = '长春Merit';
  });
  // 确保墨西哥Merit存在
  if (!d.clients.some(function(c) { return c.id === 'c14'; })) {
    d.clients.push({ id: 'c14', name: '墨西哥Merit', color: '#ff9500' });
  }
  if (!d.members) d.members = [];
  if (!d.notifications) d.notifications = [];
  if (!d.permissions) d.permissions = JSON.parse(JSON.stringify(defaultPermissions));
  if (!d.columnWidths) d.columnWidths = getDefaultColumnWidths();
  return d;
}

// 默认列宽配置
function getDefaultColumnWidths() {
  return [
    { id: 'col_check', label: '选择', width: '32px', min: '32px', max: '50px' },
    { id: 'col_segment', label: '客户细分', width: '100px', min: '60px', max: '200px' },
    { id: 'col_title', label: '任务内容', width: 'minmax(200px, 2fr)', min: '150px', max: 'minmax(400px, 3fr)' },
    { id: 'col_creator', label: '创建人', width: '80px', min: '50px', max: '120px' },
    { id: 'col_created', label: '创建时间', width: '100px', min: '70px', max: '150px' },
    { id: 'col_due', label: '计划日期', width: '100px', min: '70px', max: '150px' },
    { id: 'col_progress', label: '当前进展', width: '120px', min: '80px', max: '200px' },
    { id: 'col_completed', label: '完成日期', width: '100px', min: '70px', max: '150px' },
    { id: 'col_assignee', label: '责任人', width: '90px', min: '60px', max: '150px' },
    { id: 'col_status', label: '状态', width: '100px', min: '70px', max: '150px' },
    { id: 'col_actions', label: '操作', width: '50px', min: '40px', max: '80px' },
  ];
}

function getColumnWidthsGrid() {
  var cw = data.columnWidths || getDefaultColumnWidths();
  return cw.map(function(c) { return c.width; }).join(' ');
}

// 创建数据快照
function makeSnapshot(d) {
  return JSON.stringify({
    tasks: d.tasks,
    clients: d.clients,
    members: d.members,
    notifications: d.notifications,
    columnWidths: d.columnWidths,
  });
}

// 加载数据：云端优先，localStorage 仅做兜底
async function loadData() {
  // 1. 先尝试从云端加载（云端是唯一真实数据源）
  var cloudLoaded = false;
  try {
    var cloudRes = await apiFetch(CLOUD_DATA_PATH);
    if (cloudRes.ok) {
      var cloudData = await cloudRes.json();
      if (cloudData && (cloudData.tasks || cloudData.members || cloudData.clients)) {
        cloudLoaded = true;
        var parsed = {
          tasks: cloudData.tasks || [],
          members: cloudData.members || defaultData.members,
          clients: cloudData.clients || defaultData.clients,
          permissions: cloudData.permissions || JSON.parse(JSON.stringify(defaultPermissions)),
          notifications: cloudData.notifications || [],
        };
        normalizeData(parsed);
        parsed.currentUserId = getCurrentUserId();
        // 从 localStorage 恢复 collapsedClients（纯 UI 状态，不存在云端）
        var localData = loadLocalData();
        parsed.collapsedClients = (localData && localData.collapsedClients) ? localData.collapsedClients : [];
        lastSyncTime = Date.now();
        lastDataSnapshot = makeSnapshot(parsed);
        serverDataLoaded = true;
        saveLocalDataCache(parsed);
        console.log(`从云端加载: ${parsed.tasks.length} 条任务`);
        return parsed;
      }
    }
  } catch (e) {
    console.warn('云端加载失败，尝试本地缓存:', e.message);
  }

  // 2. 云端不可用时，从 localStorage 兜底
  var localData = loadLocalData();
  if (localData && localData.tasks && localData.tasks.length > 0) {
    var parsed = {
      tasks: localData.tasks || [],
      members: localData.members || defaultData.members,
      clients: localData.clients || defaultData.clients,
      permissions: localData.permissions || JSON.parse(JSON.stringify(defaultPermissions)),
      notifications: localData.notifications || [],
    };
    normalizeData(parsed);
    parsed.currentUserId = getCurrentUserId();
    if (!parsed.collapsedClients) parsed.collapsedClients = localData.collapsedClients || [];
    lastSyncTime = Date.now();
    lastDataSnapshot = makeSnapshot(parsed);
    serverDataLoaded = true;
    console.log(`从本地缓存加载（云端不可用）: ${parsed.tasks.length} 条任务`);
    // 云端不可用时，不主动上传本地数据（防止覆盖云端）
    return parsed;
  }

  // 3. 最终兜底：使用默认数据
  console.warn('所有加载尝试均失败，使用默认数据');
  var fallback = {
    tasks: [],
    members: defaultData.members,
    clients: defaultData.clients,
    permissions: JSON.parse(JSON.stringify(defaultPermissions)),
    notifications: [],
  };
  normalizeData(fallback);
  fallback.currentUserId = getCurrentUserId();
  fallback.collapsedClients = [];
  serverDataLoaded = true;
  lastDataSnapshot = makeSnapshot(fallback);
  return fallback;
}

// 后台同步到云端（仅在本地有数据且云端无数据时）
var cloudSyncInProgress = false;

// 立即同步到云端（fire-and-forget，不阻塞页面加载）
async function saveToCloudImmediate(d) {
  try {
    var syncData = JSON.parse(JSON.stringify(d));
    delete syncData.currentUserId;
    delete syncData.collapsedClients;
    await apiFetch(CLOUD_DATA_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncData),
    });
    console.log('立即同步到云端完成');
  } catch (e) {
    console.warn('立即同步到云端失败:', e.message);
  }
}

async function syncToCloudIfNeeded(d) {
  if (cloudSyncInProgress) return;
  cloudSyncInProgress = true;
  try {
    var checkRes = await apiFetch(CLOUD_DATA_PATH);
    if (checkRes.ok) {
      var cloudData = await checkRes.json();
      if (cloudData && cloudData.tasks && cloudData.tasks.length > 0) {
        cloudSyncInProgress = false;
        return;
      }
    }
    // 云端无数据，上传本地数据
    var syncData = JSON.parse(JSON.stringify(d));
    delete syncData.currentUserId;
    delete syncData.collapsedClients;
    await apiFetch(CLOUD_DATA_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncData),
    });
    console.log('后台同步到云端完成');
  } catch (e) {
    console.warn('后台同步失败:', e.message);
  }
  cloudSyncInProgress = false;
}

// 保存数据到服务器 + 本地缓存
function saveData() {
  if (!serverDataLoaded) {
    console.warn('数据未加载完成，跳过保存');
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDataInternal();
  }, 500);
}

async function saveDataInternal() {
  if (!data) return;
  setCurrentUserId(data.currentUserId);
  if (isSaving) {
    if (!saveTimer) {
      saveTimer = setTimeout(() => { saveTimer = null; saveDataInternal(); }, 500);
    }
    return;
  }
  isSaving = true;
  try {
    // 1. 先保存到本地缓存（快速、可靠）
    saveLocalDataCache(data);

    // 2. 保存前检查云端：如果云端任务数 > 本地任务数，说明本地数据已过期，先合并云端数据
    // 这防止其他设备的修改被本地 stale 数据覆盖
    var syncData = JSON.parse(JSON.stringify(data));
    delete syncData.currentUserId;
    delete syncData.collapsedClients;
    try {
      var preCheck = await apiFetch(CLOUD_DATA_PATH);
      if (preCheck.ok) {
        var cloudPre = await preCheck.json();
        if (cloudPre && cloudPre.tasks) {
          var localTaskMap = {};
          syncData.tasks.forEach(function(t) { localTaskMap[t.id] = t; });
          var cloudTaskMap = {};
          cloudPre.tasks.forEach(function(ct) { cloudTaskMap[ct.id] = ct; });
          var merged = false;

          // 1. 补充云端独有的任务（其他设备新增的）
          cloudPre.tasks.forEach(function(ct) {
            if (!localTaskMap[ct.id] && !deletedTaskIds.has(ct.id)) {
              syncData.tasks.push(ct);
              merged = true;
            }
          });

          // 2. 智能合并：对于两边都有的任务，保留本地修改的字段，同时合并云端新增的内容
          syncData.tasks.forEach(function(lt, idx) {
            var ct = cloudTaskMap[lt.id];
            if (!ct) return;
            // 比较云端版本，合并云端独有的增量数据
            var taskChanged = false;

            // 2a. 合并 firstViewedBy：保留所有已查看记录（取并集）
            if (ct.firstViewedBy) {
              if (!lt.firstViewedBy) lt.firstViewedBy = {};
              Object.keys(ct.firstViewedBy).forEach(function(k) {
                if (!lt.firstViewedBy[k]) {
                  lt.firstViewedBy[k] = ct.firstViewedBy[k];
                  taskChanged = true;
                }
              });
            }

            // 2b. 合并 comments：保留所有评论（按 id 去重）
            if (ct.comments && ct.comments.length > 0) {
              if (!lt.comments) lt.comments = [];
              var localCommentIds = {};
              lt.comments.forEach(function(c) { localCommentIds[c.id] = true; });
              ct.comments.forEach(function(cc) {
                if (!localCommentIds[cc.id]) {
                  lt.comments.push(cc);
                  taskChanged = true;
                }
              });
            }

            // 2c. 合并 commentReadBy：保留所有已读记录（取并集）
            if (ct.commentReadBy) {
              if (!lt.commentReadBy) lt.commentReadBy = {};
              Object.keys(ct.commentReadBy).forEach(function(k) {
                if (!lt.commentReadBy[k]) {
                  lt.commentReadBy[k] = ct.commentReadBy[k];
                  taskChanged = true;
                }
              });
            }

            // 2d. 合并 history：保留所有历史记录（按 id 去重，取并集）
            if (ct.history && ct.history.length > 0) {
              if (!lt.history) lt.history = [];
              var localHistoryIds = {};
              lt.history.forEach(function(h) { localHistoryIds[h.id] = true; });
              ct.history.forEach(function(ch) {
                if (!localHistoryIds[ch.id]) {
                  lt.history.push(ch);
                  taskChanged = true;
                }
              });
            }

            if (taskChanged) merged = true;
          });

          if (merged) {
            data.tasks = syncData.tasks.slice();
            saveLocalDataCache(data);
            console.log('保存前智能合并云端增量数据');
          }
        }
      }
    } catch (e) {
      console.warn('保存前云端检查失败:', e.message);
    }

    const saveRes = await apiFetch(CLOUD_DATA_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncData),
    });

    if (saveRes.ok) {
      lastSyncTime = Date.now();
      lastLocalSaveTime = Date.now(); // 记录本地保存时间，用于 pollSync 保护窗口
      lastDataSnapshot = makeSnapshot(syncData);
      deletedTaskIds.clear();
      console.log(`保存完成: ${syncData.tasks.length} 条任务`);
    } else {
      console.error(`云端保存失败: ${saveRes.status}`);
    }
  } catch (e) {
    console.error('保存失败:', e);
  } finally {
    isSaving = false;
  }
}

// 轮询同步：从云端拉取最新数据，带本地保存保护
let lastDataSnapshot = '';
let lastLocalSaveTime = 0; // 本地最近一次保存的时间戳
const SAVE_GUARD_WINDOW = 8000; // 保存后 8 秒内，pollSync 不会用云端数据覆盖本地（防止云端写入延迟导致回退）

async function pollSync() {
  if (!serverDataLoaded) return;
  if (isSaving) return;
  if (saveTimer) return; // 有待保存的修改，等待保存完成
  if (document.querySelector('.modal.show')) return;
  try {
    const res = await apiFetch(CLOUD_DATA_PATH);
    if (!res.ok) return;
    const serverData = await res.json();

    // 数据丢失防护：如果云端返回空数据，跳过同步
    if (!serverData.members && !serverData.clients && !serverData.tasks) {
      console.warn('pollSync: 云端数据为空，跳过同步以防数据丢失');
      return;
    }

    const parsed = {
      tasks: serverData.tasks || [],
      members: serverData.members || [],
      clients: serverData.clients || [],
      permissions: serverData.permissions || JSON.parse(JSON.stringify(defaultPermissions)),
      notifications: serverData.notifications || [],
    };
    normalizeData(parsed);

    const snapshot = makeSnapshot(parsed);
    if (snapshot === lastDataSnapshot) return; // 数据无变化，跳过

    // 保存保护：如果本地最近刚保存过，且云端任务数与本地不一致，说明云端数据可能尚未同步完成
    // 此时拒绝用云端数据覆盖本地，防止任务消失或恢复
    const now = Date.now();
    const localTaskCount = (data && data.tasks) ? data.tasks.length : 0;
    const cloudTaskCount = parsed.tasks.length;
    if (now - lastLocalSaveTime < SAVE_GUARD_WINDOW && cloudTaskCount !== localTaskCount) {
      console.warn(`pollSync: 保存保护窗口内，云端任务(${cloudTaskCount})与本地(${localTaskCount})不一致，跳过同步`);
      return;
    }

    const currentUserId = data.currentUserId;
    const collapsedClients = data.collapsedClients;

    // 保留本地最新的 commentReadBy 和 firstViewedBy（云端可能尚未同步）
    const localTaskMeta = {};
    data.tasks.forEach(function(t) {
      localTaskMeta[t.id] = {
        commentReadBy: t.commentReadBy ? JSON.parse(JSON.stringify(t.commentReadBy)) : {},
        firstViewedBy: t.firstViewedBy ? JSON.parse(JSON.stringify(t.firstViewedBy)) : {},
      };
    });

    data = parsed;
    data.currentUserId = currentUserId;
    data.collapsedClients = collapsedClients || [];

    // 合并本地最新的 commentReadBy（取最新时间戳）
    data.tasks.forEach(function(t) {
      var local = localTaskMeta[t.id];
      if (!local) return;
      if (!t.commentReadBy) t.commentReadBy = {};
      Object.keys(local.commentReadBy).forEach(function(k) {
        var localTime = local.commentReadBy[k];
        var cloudTime = t.commentReadBy[k];
        if (!cloudTime || new Date(localTime) > new Date(cloudTime)) {
          t.commentReadBy[k] = localTime;
        }
      });
      // 合并 firstViewedBy
      if (!t.firstViewedBy) t.firstViewedBy = {};
      Object.keys(local.firstViewedBy).forEach(function(k) {
        if (!t.firstViewedBy[k]) {
          t.firstViewedBy[k] = local.firstViewedBy[k];
        }
      });
    });
    lastDataSnapshot = snapshot;
    saveLocalDataCache(data);
    syncTaskStatuses();
    renderAll();
    console.log(`pollSync: 云端数据已同步 (${cloudTaskCount} 条任务)`);
  } catch (e) {
    // 静默失败
  }
}

// ==================== 权限设置 ====================
const defaultPermissions = {
  // 任务权限
  memberCanCreateTask: true,        // 组员可以新建任务
  memberCanEditTask: true,          // 组员可以编辑任务
  memberCanEditDueDate: false,      // 组员可以修改计划日期
  memberCanDeleteTask: false,      // 组员可以删除任务
  memberCanToggleComplete: true,   // 组员可以标记完成/取消完成
  // 客户权限
  memberCanAddClient: false,        // 组员可以新增客户
  memberCanEditClient: false,       // 组员可以编辑客户
  memberCanDeleteClient: false,     // 组员可以删除客户
  // 数据权限
  memberCanExport: true,            // 组员可以导出数据
  memberCanImport: false,           // 组员可以导入数据
  // 评论权限
  memberCanComment: true,           // 组员可以发表评论
  memberCanDeleteOwnComment: true,  // 组员可以删除自己的评论
};

function isAdmin() {
  const u = getCurrentUser();
  return u && u.role === '管理员';
}

// 检查权限
function hasPermission(key) {
  if (isAdmin()) return true;
  if (!data.permissions) return true; // 兼容旧数据
  return !!data.permissions[key];
}

const defaultData = {
  currentUserId: 'u3',
  collapsedClients: [],
  permissions: JSON.parse(JSON.stringify(defaultPermissions)),
  members: [
    { id: 'u1', name: '邵杰', role: '组员', color: '#5b5fc7' },
    { id: 'u2', name: '丁海燕', role: '组员', color: '#0ea5e9' },
    { id: 'u3', name: '祁佳伟', role: '管理员', color: '#34c759' },
  ],
  clients: [
    { id: 'c1', name: 'HELLA', color: '#5b5fc7' },
    { id: 'c2', name: '京瓷', color: '#0ea5e9' },
    { id: 'c3', name: '泰德兴', color: '#34c759' },
    { id: 'c4', name: 'BCS', color: '#ff9500' },
    { id: 'c5', name: '共创科技', color: '#ff3b30' },
    { id: 'c6', name: '浙江长江', color: '#af52de' },
    { id: 'c7', name: '上海泽久', color: '#5b5fc7' },
    { id: 'c8', name: '欧摩威', color: '#0ea5e9' },
    { id: 'c9', name: '顺铨', color: '#34c759' },
    { id: 'c10', name: '长春Merit', color: '#ff9500' },
    { id: 'c11', name: '和硕', color: '#ff3b30' },
    { id: 'c12', name: '恒润科技', color: '#af52de' },
    { id: 'c13', name: '其他', color: '#a1a1a6' },
    { id: 'c14', name: '墨西哥Merit', color: '#ff9500' },
  ],
  tasks: [],  // 默认任务为空，真实数据从服务器加载
  notifications: [],
};

// ==================== 工具函数 ====================
function getMember(id) { return data.members.find(m => m.id === id); }
function getClient(id) { return data.clients.find(c => c.id === id); }
function getCurrentUser() {
  if (!data || !data.members || data.members.length === 0) return { id: null, name: '未登录', role: '组员', color: '#999' };
  return getMember(data.currentUserId) || data.members[0];
}

// 获取用户对某任务的未读评论数
function getUnreadCommentCount(task, userId) {
  if (!task.comments || task.comments.length === 0) return 0;
  const readBy = task.commentReadBy || {};
  const lastReadAt = readBy[userId];
  if (!lastReadAt) {
    // 从未查看过，所有非自己的评论都是未读
    return task.comments.filter(c => c.userId !== userId).length;
  }
  const readTime = new Date(lastReadAt).getTime();
  return task.comments.filter(c => {
    if (c.userId === userId) return false; // 自己的评论不算未读
    return new Date(c.time).getTime() > readTime;
  }).length;
}

// 标记当前用户已查看某任务的全部评论
function markCommentsRead(task, userId) {
  if (!task.commentReadBy) task.commentReadBy = {};
  task.commentReadBy[userId] = new Date().toISOString();
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getMonth()+1}/${d.getDate()}`;
}

function formatDateFull(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  return formatDateFull(dateStr);
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function getInitials(name) { return name ? name.charAt(0) : '?'; }

function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ==================== Toast ====================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ==================== 视图切换 ====================
const viewTitles = { kanban: '任务看板', team: '团队成员', stats: '数据统计', notifications: '通知中心', permissions: '权限设置', columnWidths: '列宽设置' };

// 侧边栏收起/展开
const SIDEBAR_KEY = 'team_workbench_sidebar_collapsed';
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  const isCollapsed = sidebar.classList.toggle('collapsed');
  toggle.textContent = isCollapsed ? '▶' : '◀';
  localStorage.setItem(SIDEBAR_KEY, isCollapsed ? '1' : '0');
  // 如果在统计页面，需要重绘图表
  if (document.querySelector('.nav-item[data-view="stats"].active')) {
    setTimeout(renderCharts, 300);
  }
}

// 初始化侧边栏状态
function initSidebar() {
  const saved = localStorage.getItem(SIDEBAR_KEY);
  if (saved === '1') {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebarToggle');
    sidebar.classList.add('collapsed');
    toggle.textContent = '▶';
  }
}

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + viewName).classList.add('active');
  document.querySelector(`.nav-item[data-view="${viewName}"]`).classList.add('active');
  document.getElementById('pageTitle').textContent = viewTitles[viewName] || '';
  if (viewName === 'stats') setTimeout(renderCharts, 100);
  if (viewName === 'permissions') renderPermissions();
  if (viewName === 'columnWidths') renderColumnWidths();
}

document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => switchView(item.dataset.view));
});

// ==================== 登录系统 ====================
const LOGIN_KEY = 'team_workbench_login';
const REMEMBER_KEY = 'team_workbench_remember';
let USER_PASSWORDS = JSON.parse(localStorage.getItem('team_workbench_passwords') || 'null') || {
  'u1': 'sj123456',   // 邵杰
  'u2': 'dhy123456',  // 丁海燕
  'u3': 'qjw123456',  // 祁佳伟
};

function isLoggedIn() {
  return localStorage.getItem(LOGIN_KEY) === 'yes';
}

function showLogin() {
  document.getElementById('loginOverlay').classList.add('show');
  document.getElementById('loginError').textContent = '';
  // 恢复记住的账号密码
  const remembered = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
  if (remembered) {
    document.getElementById('loginUser').value = remembered.name || '';
    document.getElementById('loginPassword').value = remembered.password || '';
    document.getElementById('loginRemember').checked = true;
  } else {
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginRemember').checked = false;
  }
  setTimeout(() => document.getElementById('loginUser').focus(), 100);
}

function hideLogin() {
  document.getElementById('loginOverlay').classList.remove('show');
}

function doLogin() {
  const name = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const errorEl = document.getElementById('loginError');

  if (!name || !password) {
    errorEl.textContent = '请输入用户名和密码';
    return;
  }

  // 根据姓名查找用户
  const member = data.members.find(m => m.name === name);
  if (!member) {
    errorEl.textContent = '用户名不存在';
    return;
  }

  if (USER_PASSWORDS[member.id] !== password) {
    errorEl.textContent = '密码错误';
    return;
  }

  // 登录成功
  localStorage.setItem(LOGIN_KEY, 'yes');
  setCurrentUserId(member.id);
  data.currentUserId = member.id;

  // 记住账号密码
  if (document.getElementById('loginRemember').checked) {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ name, password }));
  } else {
    localStorage.removeItem(REMEMBER_KEY);
  }

  hideLogin();
  updateCurrentUserDisplay();
  // 登录后重新从服务器加载最新数据，确保看到所有任务
  reloadAndRender();
  showToast(`欢迎回来，${member.name}`, 'success');
}

// 重新从服务器加载数据并渲染
async function reloadAndRender() {
  // 显示加载遮罩
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (loadingOverlay) loadingOverlay.classList.remove('hide');
  // 重置状态，强制重新加载
  serverDataLoaded = false;
  data = await loadData();
  syncTaskStatuses();
  renderAll();
  if (loadingOverlay) loadingOverlay.classList.add('hide');
}

function doLogout() {
  localStorage.removeItem(LOGIN_KEY);
  localStorage.removeItem(STORAGE_KEY);
  // 重新加载页面，确保完全清除状态
  window.location.reload();
}

// 旧函数保留兼容，改为退出登录
function switchUser() {
  doLogout();
}

// ==================== 登录管理弹窗 ====================

// 切换弹窗显示/隐藏
function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  const popup = document.getElementById('userMenuPopup');
  const overlay = document.getElementById('userMenuOverlay');
  const trigger = document.getElementById('userMenuTrigger');
  if (!popup) return;

  if (popup.classList.contains('show')) {
    closeUserMenu();
  } else {
    renderUserMenu();
    popup.classList.add('show');
    overlay.classList.add('show');
    trigger.classList.add('menu-open');
  }
}

// 关闭弹窗
function closeUserMenu() {
  const popup = document.getElementById('userMenuPopup');
  const overlay = document.getElementById('userMenuOverlay');
  const trigger = document.getElementById('userMenuTrigger');
  if (popup) popup.classList.remove('show');
  if (overlay) overlay.classList.remove('show');
  if (trigger) trigger.classList.remove('menu-open');
}

// 从弹窗打开登录界面
function showLoginFromMenu() {
  closeUserMenu();
  // 如果已有记住的账号，清空让用户重新选择
  setTimeout(() => {
    showLogin();
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').textContent = '';
    document.getElementById('loginUser').focus();
  }, 200);
}

// 快速切换：预填用户名，聚焦密码框
function quickSwitchUser(memberId) {
  const member = getMember(memberId);
  if (!member) return;

  // 如果点击的就是当前已登录用户，不操作
  if (memberId === getCurrentUserId() && isLoggedIn()) {
    closeUserMenu();
    showToast('当前已登录此账号', 'info');
    return;
  }

  closeUserMenu();
  // 打开登录界面并预填用户名
  setTimeout(() => {
    showLogin();
    document.getElementById('loginUser').value = member.name;
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').textContent = '';
    // 如果记住密码了，自动填充
    const remembered = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
    if (remembered && remembered.name === member.name) {
      document.getElementById('loginPassword').value = remembered.password || '';
      document.getElementById('loginRemember').checked = true;
    } else {
      document.getElementById('loginRemember').checked = false;
    }
    document.getElementById('loginPassword').focus();
  }, 200);
}

// 渲染弹窗内容
function renderUserMenu() {
  const statusEl = document.getElementById('userMenuStatus');
  const memberListEl = document.getElementById('userMenuMemberList');
  const loginBtn = document.getElementById('userMenuLoginBtn');
  const logoutBtn = document.getElementById('userMenuLogoutBtn');
  if (!statusEl || !memberListEl) return;

  const loggedIn = isLoggedIn();
  const user = getCurrentUser();

  // 渲染当前登录状态
  if (loggedIn && user.id) {
    statusEl.innerHTML = `
      <div class="status-avatar" style="background:${user.color}">${getInitials(user.name)}</div>
      <div class="status-info">
        <div class="status-name">${escapeHtml(user.name)}</div>
        <div class="status-role">${user.role === '管理员' ? '管理员' : '组员'}</div>
      </div>
      <span class="status-badge">在线</span>
    `;
  } else {
    statusEl.innerHTML = `
      <div class="status-avatar" style="background:#a1a1a6">?</div>
      <div class="status-info">
        <div class="status-name">未登录</div>
        <div class="status-role">请登录后使用</div>
      </div>
      <span class="status-badge offline">离线</span>
    `;
  }

  // 渲染成员列表（快速切换）
  const members = (data && data.members) ? data.members : [];
  const currentId = getCurrentUserId();
  memberListEl.innerHTML = members.map(m => {
    const isActive = loggedIn && m.id === currentId;
    return `
      <div class="user-menu-member-item ${isActive ? 'active' : ''}" onclick="quickSwitchUser('${m.id}')">
        <div class="member-avatar" style="background:${m.color}">${getInitials(m.name)}</div>
        <div class="member-name">${escapeHtml(m.name)}</div>
        <div class="member-role">${m.role === '管理员' ? '管理员' : '组员'}</div>
        ${isActive ? '<span class="member-check">✓</span>' : ''}
      </div>
    `;
  }).join('');

  // 按钮状态
  if (loggedIn) {
    loginBtn.style.display = 'none';
    logoutBtn.style.display = 'flex';
    logoutBtn.disabled = false;
  } else {
    loginBtn.style.display = 'flex';
    logoutBtn.style.display = 'none';
  }
}

// 点击页面其他区域关闭弹窗
document.addEventListener('click', function(e) {
  const popup = document.getElementById('userMenuPopup');
  const trigger = document.getElementById('userMenuTrigger');
  if (popup && popup.classList.contains('show')) {
    if (!popup.contains(e.target) && !trigger.contains(e.target)) {
      closeUserMenu();
    }
  }
});

// ESC 键关闭弹窗
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeUserMenu();
  }
});

function updateCurrentUserDisplay() {
  const user = getCurrentUser();
  const nameEl = document.getElementById('currentUserName');
  const avatarEl = document.getElementById('currentUserAvatar');
  const roleEl = nameEl ? nameEl.nextElementSibling : null;

  if (isLoggedIn() && user.id) {
    nameEl.textContent = user.name;
    avatarEl.textContent = getInitials(user.name);
    avatarEl.style.background = user.color;
    if (roleEl) roleEl.textContent = user.role === '管理员' ? '管理员' : '组员';
  } else {
    nameEl.textContent = '未登录';
    avatarEl.textContent = '?';
    avatarEl.style.background = '#a1a1a6';
    if (roleEl) roleEl.textContent = '点击登录管理';
  }
}

function adjustColor(color, amount) {
  const hex = color.replace('#', '');
  const num = parseInt(hex, 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amount));
  const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amount));
  return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

// ==================== 状态定义 ====================
const statusConfig = {
  todo: { label: '待办', class: 'todo' },
  'in-progress': { label: '进行中', class: 'in-progress' },
  overdue: { label: '逾期中', class: 'overdue' },
  done: { label: '已完成', class: 'done' },
};

const statusOrder = ['todo', 'in-progress', 'overdue', 'done'];

// 自动计算任务状态
function getTaskStatus(task) {
  // 已完成：完成日期已填写
  if (task.completedDate) return 'done';

  const currentUserId = data ? data.currentUserId : getCurrentUserId();

  // 待办：当责任人尚未点击过此任务时，所有人都看到"待办"
  // 不管是管理员（创建者）还是组员，只要对应的责任人没点过，就显示待办
  if (task.createdBy && task.assignees && task.assignees.length > 0) {
    const viewedBy = task.firstViewedBy || {};

    if (task.assignees.includes(currentUserId)) {
      // 当前登录用户是责任人之一：自己没点过 → 待办
      if (!viewedBy[currentUserId]) {
        return 'todo';
      }
    } else {
      // 当前用户不是责任人（如管理员）：只要还有责任人没点过 → 待办
      const anyNotViewed = task.assignees.some(function(aid) {
        return !viewedBy[aid];
      });
      if (anyNotViewed) {
        return 'todo';
      }
    }
  }

  // 逾期中：当前日期已超计划日期，完成日期为空
  if (task.dueDate && isOverdue(task.dueDate)) return 'overdue';

  // 进行中：当前日期未超计划日期，完成日期为空
  return 'in-progress';
}

// 同步所有任务状态到内存（渲染前调用）
function syncTaskStatuses() {
  data.tasks.forEach(t => { t.status = getTaskStatus(t); });
}

// ==================== 任务看板 - 客户分组清单 ====================
let currentStatusFilter = 'all';
let currentSearchQuery = '';

function toggleClient(clientId) {
  const idx = data.collapsedClients.indexOf(clientId);
  if (idx >= 0) {
    data.collapsedClients.splice(idx, 1);
  } else {
    data.collapsedClients.push(clientId);
  }
  saveData();
  renderKanban();
}

// 一键展开/收起全部
function toggleAllClients() {
  const allCollapsed = data.clients.length > 0 && data.clients.every(c => data.collapsedClients.includes(c.id));
  if (allCollapsed) {
    // 全部收起状态 -> 全部展开
    data.collapsedClients = [];
  } else {
    // 全部收起
    data.collapsedClients = data.clients.map(c => c.id);
  }
  saveData();
  renderKanban();
}

// 客户拖拽排序
function bindClientDragSort() {
  const grid = document.getElementById('clientsGrid');
  if (!grid) return;
  let draggedClient = null;

  grid.querySelectorAll('.client-card').forEach(card => {
    card.setAttribute('draggable', 'true');

    card.addEventListener('dragstart', function(e) {
      draggedClient = this;
      this.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', function() {
      this.style.opacity = '';
      draggedClient = null;
      // 清除所有拖拽指示
      grid.querySelectorAll('.client-card').forEach(c => c.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (this !== draggedClient) {
        grid.querySelectorAll('.client-card').forEach(c => c.classList.remove('drag-over'));
        this.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });

    card.addEventListener('drop', function(e) {
      e.preventDefault();
      if (draggedClient && this !== draggedClient) {
        const fromId = draggedClient.dataset.clientId;
        const toId = this.dataset.clientId;
        const fromIdx = data.clients.findIndex(c => c.id === fromId);
        const toIdx = data.clients.findIndex(c => c.id === toId);
        if (fromIdx >= 0 && toIdx >= 0) {
          const [moved] = data.clients.splice(fromIdx, 1);
          data.clients.splice(toIdx, 0, moved);
          saveData();
          renderKanban();
        }
      }
    });
  });
}

function renderKanban() {
  const grid = document.getElementById('clientsGrid');
  grid.innerHTML = '';

  data.clients.forEach(client => {
    const isCollapsed = data.collapsedClients.includes(client.id);
    let tasks = data.tasks.filter(t => t.clientId === client.id);
    
    // 状态筛选
    if (currentStatusFilter !== 'all') {
      tasks = tasks.filter(t => getTaskStatus(t) === currentStatusFilter);
    }
    // 搜索筛选
    if (currentSearchQuery) {
      const q = currentSearchQuery.toLowerCase();
      tasks = tasks.filter(t => {
        if (t.title.toLowerCase().includes(q)) return true;
        if (t.progress && t.progress.toLowerCase().includes(q)) return true;
        if (t.segment && t.segment.toLowerCase().includes(q)) return true;
        if (client.name.toLowerCase().includes(q)) return true;
        if (t.assignees.some(aid => {
          const m = getMember(aid);
          return m && m.name.toLowerCase().includes(q);
        })) return true;
        if (t.tags && t.tags.some(tag => tag.toLowerCase().includes(q))) return true;
        const creator = getMember(t.createdBy);
        if (creator && creator.name.toLowerCase().includes(q)) return true;
        return false;
      });
    }

    // 排序：未完成在上半部分，已完成在下半部分；同组内按创建日期从新到旧
    tasks.sort((a, b) => {
      const aDone = getTaskStatus(a) === 'done' ? 1 : 0;
      const bDone = getTaskStatus(b) === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });

    const totalCount = data.tasks.filter(t => t.clientId === client.id).length;
    const doneCount = data.tasks.filter(t => t.clientId === client.id && getTaskStatus(t) === 'done').length;
    const progressCount = data.tasks.filter(t => t.clientId === client.id && getTaskStatus(t) === 'in-progress').length;

    const card = document.createElement('div');
    card.className = 'client-card' + (isCollapsed ? ' collapsed' : '');
    card.setAttribute('data-client-id', client.id);
    card.innerHTML = `
      <div class="client-header" style="--client-color: ${client.color}" onclick="toggleClient('${client.id}')">
        <div class="client-title">
          <div class="client-toggle">▼</div>
          <div class="client-name" style="border-left: 3px solid ${client.color}; padding-left: 10px;">${escapeHtml(client.name)}</div>
        </div>
        <div class="client-stats">
          <div class="client-stat">共 <span class="num">${totalCount}</span></div>
          <div class="client-stat">进行中 <span class="num" style="color:var(--accent)">${progressCount}</span></div>
          <div class="client-stat">已完成 <span class="num" style="color:var(--success)">${doneCount}</span></div>
        </div>
        <div class="client-actions" onclick="event.stopPropagation()">
          ${hasPermission('memberCanCreateTask') ? `<button class="client-action-btn" title="在此客户下新建任务" onclick="event.stopPropagation();openTaskModalForClient('${client.id}')">➕</button>` : ''}
          ${hasPermission('memberCanEditClient') ? `<button class="client-action-btn" title="编辑客户" onclick="event.stopPropagation();openClientModal('${client.id}')">✏️</button>` : ''}
          ${hasPermission('memberCanDeleteClient') ? `<button class="client-action-btn" title="删除客户" onclick="event.stopPropagation();deleteClient('${client.id}')">🗑️</button>` : ''}
        </div>
      </div>
      <div class="client-body">
        <div class="task-list">
          <div class="task-list-header" style="grid-template-columns:${getColumnWidthsGrid()}">
            <div style="width:32px;display:flex;align-items:center;justify-content:center">
              <input type="checkbox" class="select-all-checkbox" onclick="toggleSelectAll('${client.id}', this.checked)" title="全选/取消全选" style="width:15px;height:15px;cursor:pointer">
            </div>
            <div>客户细分</div>
            <div>任务内容</div>
            <div>创建人</div>
            <div>创建时间</div>
            <div>计划日期</div>
            <div>当前进展</div>
            <div>完成日期</div>
            <div>责任人</div>
            <div>状态</div>
            <div></div>
          </div>
          ${tasks.length > 0 ? tasks.map(function(t) { return renderTaskRow(t, client.id); }).join('') : `
            <div class="client-empty">
              <div style="font-size:28px;opacity:0.4;margin-bottom:6px">📭</div>
              <div>${currentStatusFilter !== 'all' || currentSearchQuery ? '没有符合条件的任务' : '暂无任务，点击 ➕ 添加'}</div>
            </div>
          `}
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // 绑定行点击
  document.querySelectorAll('.task-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.status-pill') || e.target.closest('.task-row-more') || e.target.closest('.status-dropdown')) return;
      openDetail(row.dataset.taskId);
    });
  });

  // 绑定客户拖拽排序
  bindClientDragSort();
}

function renderTaskRow(task, clientId) {
  const status = getTaskStatus(task);
  const sc = statusConfig[status] || statusConfig.todo;
  const overdue = status === 'overdue';
  const creator = getMember(task.createdBy);
  const createdDate = task.createdAt ? formatDate(task.createdAt) : '-';
  const unreadCount = getUnreadCommentCount(task, data.currentUserId);
  const totalComments = (task.comments || []).length;

  return `
    <div class="task-row" data-task-id="${task.id}" style="grid-template-columns:${getColumnWidthsGrid()}">
      <div class="task-row-cell" style="display:flex;align-items:center;justify-content:center" onclick="event.stopPropagation()">
        <input type="checkbox" class="task-checkbox" data-task-id="${task.id}" onclick="toggleSelectTask('${task.id}', this.checked)" style="width:15px;height:15px;cursor:pointer">
      </div>
      <div class="task-row-cell">
        ${task.segment ? `<span class="task-row-segment">${escapeHtml(task.segment)}</span>` : '<span style="color:var(--muted)">-</span>'}
      </div>
      <div class="task-row-content">
        <div class="task-row-title">${escapeHtml(task.title)}</div>
      </div>
      <div class="task-row-cell" style="display:flex;align-items:center;gap:4px">
        ${creator ? `<div class="avatar xs" style="background:${creator.color};margin-left:0">${getInitials(creator.name)}</div><span>${escapeHtml(creator.name)}</span>` : '-'}
      </div>
      <div class="task-row-cell task-row-date">${createdDate}</div>
      <div class="task-row-cell task-row-date ${overdue ? 'overdue' : ''}">${task.dueDate ? formatDate(task.dueDate) : '-'}</div>
      <div class="task-row-progress" title="${escapeHtml(task.progress || '')}">${escapeHtml(task.progress || '-')}</div>
      <div class="task-row-cell task-row-date ${task.completedDate ? 'done' : ''}">${task.completedDate ? formatDate(task.completedDate) : '-'}</div>
      <div class="task-row-assignees">
        ${task.assignees.slice(0, 2).map(aid => {
          const m = getMember(aid);
          if (!m) return '';
          return `<div class="avatar xs" style="background:${m.color}" title="${escapeHtml(m.name)}">${getInitials(m.name)}</div>`;
        }).join('')}
        ${task.assignees.length > 2 ? `<div class="avatar xs" style="background:#a1a1a6">+${task.assignees.length-2}</div>` : ''}
        ${task.assignees.length === 0 ? '<span style="color:var(--muted);font-size:11px">-</span>' : ''}
      </div>
      <div style="position:relative;display:flex;align-items:center;gap:6px">
        ${unreadCount > 0 ? `<span class="comment-badge unread" title="${unreadCount} 条未读评论">${unreadCount}</span>` : totalComments > 0 ? `<span class="comment-badge read" title="${totalComments} 条评论（已读）">💬</span>` : ''}
        <span class="status-pill ${sc.class}" data-task-id="${task.id}">
          <span class="status-dot"></span>${sc.label}
        </span>
      </div>
      <div class="task-row-more" onclick="event.stopPropagation();showTaskMenu(event, '${task.id}')">⋯</div>
    </div>
  `;
}

// 切换任务完成状态
function toggleTaskComplete(taskId) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!hasPermission('memberCanToggleComplete')) {
    showToast('你没有标记任务完成的权限', 'error');
    return;
  }
  if (task.completedDate) {
    task.completedDate = '';
    addHistory(task, '取消完成状态');
    showToast('已取消完成状态', 'info');
  } else {
    task.completedDate = new Date().toISOString().split('T')[0];
    addHistory(task, '标记任务为已完成');
    showToast('任务已标记为已完成', 'success');
    task.assignees.forEach(uid => {
      if (uid !== data.currentUserId) {
        addNotification(uid, 'status', task.id,
          `${getCurrentUser().name} 将任务「${task.title}」标记为已完成`);
      }
    });
  }
  saveData();
  renderAll();
}

function closeAllDropdowns() {
  const d = document.getElementById('activeStatusDropdown');
  if (d) d.remove();
  const m = document.getElementById('activeTaskMenu');
  if (m) m.remove();
}

// 显示任务操作菜单
function showTaskMenu(e, taskId) {
  e.stopPropagation();
  closeAllDropdowns();
  const rect = e.target.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'status-dropdown';
  menu.id = 'activeTaskMenu';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - rect.right) + 'px';
  menu.style.left = 'auto';
  menu.style.minWidth = '100px';

  const options = [];
  if (hasPermission('memberCanEditTask')) {
    options.push({ label: '✏️ 编辑', action: () => { closeAllDropdowns(); openDetail(taskId); setTimeout(() => editCurrentTask(), 100); } });
  }
  if (hasPermission('memberCanDeleteTask')) {
    options.push({ label: '🗑️ 删除', action: () => { closeAllDropdowns(); deleteTaskDirectly(taskId); }, danger: true });
  }
  if (options.length === 0) {
    options.push({ label: '👀 查看详情', action: () => { closeAllDropdowns(); openDetail(taskId); } });
  }

  options.forEach(o => {
    const opt = document.createElement('div');
    opt.className = 'status-option';
    if (o.danger) opt.style.color = 'var(--danger)';
    opt.textContent = o.label;
    opt.onclick = (ev) => { ev.stopPropagation(); o.action(); };
    menu.appendChild(opt);
  });

  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', closeAllDropdowns, { once: true });
  }, 0);
}

function deleteTaskDirectly(taskId) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!hasPermission('memberCanDeleteTask')) {
    showToast('你没有删除任务的权限', 'error');
    return;
  }
  if (!confirm(`确定要删除任务「${task.title}」吗？`)) return;
  // 记录删除的任务ID，防止saveDataInternal合并时从服务器恢复
  deletedTaskIds.add(taskId);
  data.tasks = data.tasks.filter(t => t.id !== taskId);
  selectedTaskIds.delete(taskId);
  saveData();
  renderAll();
  showToast('任务已删除', 'warning');
}

// 批量选择
function toggleSelectTask(taskId, checked) {
  if (checked) {
    selectedTaskIds.add(taskId);
  } else {
    selectedTaskIds.delete(taskId);
  }
  updateBatchBar();
}

function toggleSelectAll(clientId, checked) {
  const tasks = data.tasks.filter(t => t.clientId === clientId);
  if (currentStatusFilter !== 'all') {
    tasks = tasks.filter(t => getTaskStatus(t) === currentStatusFilter);
  }
  tasks.forEach(t => {
    if (checked) {
      selectedTaskIds.add(t.id);
    } else {
      selectedTaskIds.delete(t.id);
    }
  });
  // 更新当前客户下的所有复选框
  document.querySelectorAll(`[data-client-id="${clientId}"] .task-checkbox`).forEach(cb => {
    cb.checked = checked;
  });
  updateBatchBar();
}

function updateBatchBar() {
  const bar = document.getElementById('batchActionBar');
  const count = document.getElementById('batchCount');
  if (!bar) return;
  if (selectedTaskIds.size > 0) {
    bar.style.display = 'flex';
    count.textContent = selectedTaskIds.size;
  } else {
    bar.style.display = 'none';
  }
}

function batchDeleteTasks() {
  if (selectedTaskIds.size === 0) return;
  if (!hasPermission('memberCanDeleteTask')) {
    showToast('你没有删除任务的权限', 'error');
    return;
  }
  const count = selectedTaskIds.size;
  if (!confirm(`确定要删除选中的 ${count} 个任务吗？此操作不可恢复。`)) return;
  selectedTaskIds.forEach(id => deletedTaskIds.add(id));
  data.tasks = data.tasks.filter(t => !selectedTaskIds.has(t.id));
  selectedTaskIds.clear();
  saveData();
  renderAll();
  showToast(`已删除 ${count} 个任务`, 'warning');
}

function clearSelection() {
  selectedTaskIds.clear();
  document.querySelectorAll('.task-checkbox').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.select-all-checkbox').forEach(cb => { cb.checked = false; });
  updateBatchBar();
}

// 状态筛选
document.querySelectorAll('#statusFilters .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#statusFilters .filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentStatusFilter = chip.dataset.status;
    renderKanban();
  });
});

// 搜索
document.getElementById('searchInput').addEventListener('input', (e) => {
  currentSearchQuery = e.target.value;
  renderKanban();
});

// ==================== 任务弹窗 ====================
let editingTaskId = null;
let selectedAssignees = [];

// 客户细分联动配置
function getSegmentOptions(clientId) {
  const client = getClient(clientId);
  if (!client) return [];
  const name = client.name;
  // HELLA → 上海HELLA, 长春HELLA
  if (name === 'HELLA') return ['上海HELLA', '长春HELLA'];
  // 欧摩威 → 长春欧摩威, 墨西哥欧摩威
  if (name === '欧摩威') return ['长春欧摩威', '墨西哥欧摩威'];
  // 其它客户 → 客户细分 = 客户名称
  return [name];
}

function updateSegmentDropdown(selectedValue) {
  const clientId = document.getElementById('taskClient').value;
  const options = getSegmentOptions(clientId);
  const segmentSelect = document.getElementById('taskSegment');
  segmentSelect.innerHTML = options.map(s =>
    `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
  ).join('');
  if (selectedValue && options.includes(selectedValue)) {
    segmentSelect.value = selectedValue;
  }
}

function openTaskModal(clientId = null) {
  if (!hasPermission('memberCanCreateTask')) {
    showToast('你没有创建任务的权限', 'error');
    return;
  }
  editingTaskId = null;
  selectedAssignees = [];
  document.getElementById('taskModalTitle').textContent = '新建任务';
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskProgress').value = '';
  document.getElementById('taskDue').value = '';
  document.getElementById('taskCompletedDate').value = '';

  // 新建任务时重置计划日期权限（新建时所有人都能设）
  const dueInput = document.getElementById('taskDue');
  dueInput.disabled = false;
  dueInput.style.opacity = '';
  dueInput.title = '';

  // 填充客户下拉
  const clientSelect = document.getElementById('taskClient');
  clientSelect.innerHTML = data.clients.map(c =>
    `<option value="${c.id}" ${clientId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');
  if (!clientId && data.clients.length > 0) {
    clientSelect.value = data.clients[0].id;
  }

  // 联动客户细分
  updateSegmentDropdown();

  renderMemberPicker();
  document.getElementById('taskModal').classList.add('show');
}

function openTaskModalForClient(clientId) {
  openTaskModal(clientId);
}

function closeTaskModal() {
  document.getElementById('taskModal').classList.remove('show');
  editingTaskId = null;
  selectedAssignees = [];
}

function renderMemberPicker() {
  const picker = document.getElementById('memberPicker');
  picker.innerHTML = data.members.map(m => `
    <div class="member-chip ${selectedAssignees.includes(m.id) ? 'selected' : ''}" onclick="toggleAssignee('${m.id}')">
      <div class="avatar" style="background:${m.color}">${getInitials(m.name)}</div>
      ${escapeHtml(m.name)}
    </div>
  `).join('');
}

function toggleAssignee(mid) {
  const idx = selectedAssignees.indexOf(mid);
  if (idx >= 0) selectedAssignees.splice(idx, 1);
  else selectedAssignees.push(mid);
  renderMemberPicker();
}

function saveTask() {
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) { showToast('请输入任务内容', 'error'); return; }

  const clientId = document.getElementById('taskClient').value;
  const segment = document.getElementById('taskSegment').value;
  if (!segment) { showToast('请选择客户细分', 'error'); return; }
  const progress = document.getElementById('taskProgress').value.trim();
  const dueDate = document.getElementById('taskDue').value;
  if (!dueDate) { showToast('请选择计划日期', 'error'); return; }
  if (selectedAssignees.length === 0) { showToast('请选择至少一个责任人', 'error'); return; }
  const completedDate = document.getElementById('taskCompletedDate').value;

  if (editingTaskId) {
    const task = data.tasks.find(t => t.id === editingTaskId);
    if (task) {
      const oldAssignees = task.assignees;
      // 记录变更内容
      const changes = [];
      if (task.title !== title) changes.push(`任务标题: 「${task.title}」→「${title}」`);
      if (task.segment !== segment) changes.push(`客户细分: ${task.segment || '无'} → ${segment}`);
      if (task.progress !== progress) changes.push(`当前进展: ${task.progress || '无'} → ${progress || '无'}`);
      if (task.dueDate !== dueDate) changes.push(`计划日期: ${task.dueDate || '无'} → ${dueDate}`);
      if (task.completedDate !== completedDate) changes.push(`完成日期: ${task.completedDate || '无'} → ${completedDate || '无'}`);
      const oldClient = getClient(task.clientId);
      const newClient = getClient(clientId);
      if (task.clientId !== clientId) changes.push(`所属客户: ${oldClient ? oldClient.name : '无'} → ${newClient ? newClient.name : '无'}`);
      const oldNames = oldAssignees.map(a => { const m = getMember(a); return m ? m.name : a; }).join('、');
      const newNames = selectedAssignees.map(a => { const m = getMember(a); return m ? m.name : a; }).join('、');
      if (oldAssignees.join(',') !== selectedAssignees.join(',')) changes.push(`负责人: ${oldNames || '无'} → ${newNames || '无'}`);

      task.title = title;
      task.segment = segment;
      task.progress = progress;
      task.dueDate = dueDate;
      task.completedDate = completedDate;
      task.clientId = clientId;
      task.assignees = [...selectedAssignees];
      selectedAssignees.forEach(uid => {
        if (!oldAssignees.includes(uid) && uid !== data.currentUserId) {
          addNotification(uid, 'task', task.id, `${getCurrentUser().name} 将任务「${task.title}」指派给你`);
        }
      });
      if (changes.length > 0) {
        addHistory(task, changes.length === 1 ? changes[0] : `更新了 ${changes.length} 项内容：\n${changes.join('；')}`);
      }
      showToast('任务已更新', 'success');
    }
  } else {
    const newTask = {
      id: uid('t'), title, segment, progress, dueDate, completedDate,
      clientId, assignees: [...selectedAssignees],
      createdAt: new Date().toISOString(),
      createdBy: data.currentUserId,
      firstViewedBy: {},
      comments: [],
      commentReadBy: {},
      history: [],
    };
    const assigneeNames = selectedAssignees.map(a => { const m = getMember(a); return m ? m.name : ''; }).filter(Boolean).join('、');
    addHistory(newTask, `创建任务，指派给 ${assigneeNames || '未指派'}，计划日期 ${dueDate}`);
    data.tasks.unshift(newTask);
    selectedAssignees.forEach(uid => {
      if (uid !== data.currentUserId) {
        addNotification(uid, 'task', newTask.id, `${getCurrentUser().name} 指派了新任务「${newTask.title}」给你`);
      }
    });
    showToast('任务已创建', 'success');
  }

  saveData();
  closeTaskModal();
  renderAll();
}

// 客户切换时联动客户细分
document.getElementById('taskClient').addEventListener('change', function() {
  updateSegmentDropdown();
});

// ==================== 任务详情 ====================
let currentDetailTaskId = null;

function openDetail(taskId) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  currentDetailTaskId = taskId;

  // 只有"责任人（组员）"点击任务时，才取消待办状态
  // 管理员（创建者）如果不是责任人，点击不影响待办；如果是责任人，点击也取消待办
  let needsSave = false;
  if (task.createdBy && task.assignees &&
      task.assignees.includes(data.currentUserId)) {
    if (!task.firstViewedBy) task.firstViewedBy = {};
    if (!task.firstViewedBy[data.currentUserId]) {
      task.firstViewedBy[data.currentUserId] = new Date().toISOString();
      needsSave = true;
    }
  }

  // 标记当前用户已查看此任务的所有评论（清除未读红点）
  if (getUnreadCommentCount(task, data.currentUserId) > 0) {
    markCommentsRead(task, data.currentUserId);
    needsSave = true;
  }
  if (needsSave) saveData();

  const status = getTaskStatus(task);
  const sc = statusConfig[status];
  const client = getClient(task.clientId);
  const creator = getMember(task.createdBy);

  document.getElementById('detailStatusBadge').textContent = sc.label;
  document.getElementById('detailStatusBadge').style.background = hexToRgba(getStatusColor(status), 0.12);
  document.getElementById('detailStatusBadge').style.color = getStatusColor(status);

  document.getElementById('detailPriority').textContent = task.segment || '无细分';
  document.getElementById('detailPriority').className = 'priority-pill';
  document.getElementById('detailPriority').style.background = 'rgba(0,0,0,0.04)';
  document.getElementById('detailPriority').style.color = 'var(--muted)';

  document.getElementById('detailClient').textContent = client ? '🏢 ' + client.name : '';
  document.getElementById('detailTitle').textContent = task.title;
  document.getElementById('detailDue').textContent = task.dueDate ? formatDateFull(task.dueDate) : '未设置';
  document.getElementById('detailCompleted').textContent = task.completedDate ? formatDateFull(task.completedDate) : '未完成';
  document.getElementById('detailCreated').textContent = creator ? `${creator.name} · ${formatDateTime(task.createdAt)}` : formatDateTime(task.createdAt);
  document.getElementById('detailDesc').textContent = task.progress || '暂无进展描述';

  renderHistory(task);

  document.getElementById('detailAssignees').innerHTML = task.assignees.map(aid => {
    const m = getMember(aid);
    if (!m) return '';
    return `<div class="detail-assignee"><div class="avatar sm" style="background:${m.color}">${getInitials(m.name)}</div>${escapeHtml(m.name)}</div>`;
  }).join('') || '<span style="color:var(--muted);font-size:12px">暂未指派</span>';

  renderComments(task);

  // 评论输入区域权限控制
  const commentInputRow = document.querySelector('.comment-input-row');
  if (commentInputRow) {
    commentInputRow.style.display = hasPermission('memberCanComment') ? '' : 'none';
  }

  // 更新完成按钮文本和权限
  const toggleBtn = document.getElementById('toggleCompleteBtn');
  if (toggleBtn) {
    toggleBtn.style.display = hasPermission('memberCanToggleComplete') ? '' : 'none';
    if (task.completedDate) {
      toggleBtn.textContent = '↩️ 取消完成';
      toggleBtn.className = 'btn btn-secondary';
    } else {
      toggleBtn.textContent = '✅ 标记为已完成';
      toggleBtn.className = 'btn btn-primary';
    }
  }
  // 编辑/删除按钮权限
  const editBtn = document.getElementById('editTaskBtn');
  if (editBtn) editBtn.style.display = hasPermission('memberCanEditTask') ? '' : 'none';
  const delBtn = document.getElementById('deleteTaskBtn');
  if (delBtn) delBtn.style.display = hasPermission('memberCanDeleteTask') ? '' : 'none';

  document.getElementById('detailModal').classList.add('show');
  document.getElementById('commentInput').value = '';
}

function getStatusColor(status) {
  return { todo: '#6e6e73', 'in-progress': '#5b5fc7', overdue: '#ff3b30', done: '#34c759' }[status] || '#6e6e73';
}

// ==================== 履历记录 ====================
function addHistory(task, desc) {
  if (!task.history) task.history = [];
  task.history.unshift({
    id: uid('h'),
    time: new Date().toISOString(),
    userId: data.currentUserId,
    desc: desc,
  });
}

function renderHistory(task) {
  const container = document.getElementById('detailHistory');
  if (!container) return;
  if (!task.history || task.history.length === 0) {
    container.innerHTML = '<div class="history-empty">暂无变更记录</div>';
    return;
  }
  container.innerHTML = task.history.map(h => {
    const m = getMember(h.userId);
    const color = m ? m.color : '#a1a1a6';
    const initials = m ? getInitials(m.name) : '?';
    const name = m ? m.name : '未知';
    return `
      <div class="history-item">
        <div class="history-item-row">
          <span class="history-item-date">${formatDateTime(h.time)}</span>
          <span class="history-item-editor">
            <span class="avatar xx" style="background:${color}">${initials}</span>${escapeHtml(name)}
          </span>
        </div>
        <div class="history-item-desc">${escapeHtml(h.desc)}</div>
      </div>
    `;
  }).join('');
}

function renderComments(task) {
  const list = document.getElementById('detailComments');
  if (!task.comments || task.comments.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-state-icon" style="font-size:32px">💬</div><div class="empty-state-text" style="font-size:12px">暂无评论</div></div>';
    return;
  }
  list.innerHTML = task.comments.map(c => {
    const m = getMember(c.userId);
    const canDelete = c.userId === data.currentUserId && hasPermission('memberCanDeleteOwnComment');
    return `
      <div class="comment">
        <div class="avatar sm" style="background:${m ? m.color : '#a1a1a6'}">${m ? getInitials(m.name) : '?'}</div>
        <div class="comment-content">
          <div class="comment-header">
            <span class="comment-author">${escapeHtml(m ? m.name : '未知')}</span>
            <span class="comment-time">${formatDateTime(c.time)}</span>
          </div>
          <div class="comment-text">${escapeHtml(c.text)}</div>
        </div>
        ${canDelete ? `<button class="comment-delete" onclick="deleteComment('${task.id}', '${c.id}')" title="删除自己的评论">✕</button>` : ''}
      </div>
    `;
  }).join('');
}

function deleteComment(taskId, commentId) {
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  const comment = task.comments.find(c => c.id === commentId);
  if (!comment) return;
  // 只能删除自己的评论
  if (comment.userId !== data.currentUserId) {
    showToast('只能删除自己的评论', 'error');
    return;
  }
  if (!hasPermission('memberCanDeleteOwnComment')) {
    showToast('你没有删除评论的权限', 'error');
    return;
  }
  if (!confirm('确定要删除这条评论吗？')) return;
  task.comments = task.comments.filter(c => c.id !== commentId);
  addHistory(task, `删除了评论`);
  saveData();
  renderComments(task);
  renderKanban();
  showToast('评论已删除', 'success');
}

function addComment() {
  if (!hasPermission('memberCanComment')) {
    showToast('你没有发表评论的权限', 'error');
    return;
  }
  const input = document.getElementById('commentInput');
  const text = input.value.trim();
  if (!text || !currentDetailTaskId) return;
  const task = data.tasks.find(t => t.id === currentDetailTaskId);
  if (!task) return;
  task.comments.push({
    id: uid('c'), userId: data.currentUserId, text, time: new Date().toISOString(),
  });
  const commentPreview = text.length > 30 ? text.substring(0, 30) + '...' : text;
  addHistory(task, `发表评论：${commentPreview}`);
  // 评论者自己已读所有评论
  markCommentsRead(task, data.currentUserId);
  saveData();
  renderComments(task);
  input.value = '';
  showToast('评论已发送', 'success');

  // 通知所有相关人员（负责人、创建人、之前评论过的用户），排除自己
  const notifyUserIds = new Set(task.assignees);
  if (task.createdBy) notifyUserIds.add(task.createdBy);
  task.comments.forEach(c => { if (c.userId !== data.currentUserId) notifyUserIds.add(c.userId); });
  notifyUserIds.delete(data.currentUserId);

  notifyUserIds.forEach(uid => {
    addNotification(uid, 'comment', task.id,
      `${getCurrentUser().name} 在「${task.title}」中评论：${commentPreview}`);
  });
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('show');
  const hadTask = currentDetailTaskId;
  currentDetailTaskId = null;
  // 关闭详情后重新渲染看板，确保"待办→进行中/逾期"等状态变化即时反映
  if (hadTask) renderAll();
}

function editCurrentTask() {
  const task = data.tasks.find(t => t.id === currentDetailTaskId);
  if (!task) return;
  if (!hasPermission('memberCanEditTask')) {
    showToast('你没有编辑任务的权限', 'error');
    return;
  }
  closeDetailModal();
  editingTaskId = task.id;
  selectedAssignees = [...task.assignees];
  document.getElementById('taskModalTitle').textContent = '编辑任务';
  document.getElementById('taskTitle').value = task.title;
  document.getElementById('taskProgress').value = task.progress || '';
  document.getElementById('taskDue').value = task.dueDate || '';
  document.getElementById('taskCompletedDate').value = task.completedDate || '';

  // 计划日期权限：组员不可修改时禁用
  const dueInput = document.getElementById('taskDue');
  const canEditDue = hasPermission('memberCanEditDueDate');
  dueInput.disabled = !canEditDue;
  dueInput.style.opacity = canEditDue ? '' : '0.5';
  dueInput.title = canEditDue ? '' : '计划日期由管理员设置，组员不可修改';

  const clientSelect = document.getElementById('taskClient');
  clientSelect.innerHTML = data.clients.map(c =>
    `<option value="${c.id}" ${task.clientId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
  ).join('');

  // 联动客户细分，选中已有值
  updateSegmentDropdown(task.segment || '');

  renderMemberPicker();
  document.getElementById('taskModal').classList.add('show');
}

function deleteCurrentTask() {
  if (!currentDetailTaskId) return;
  deleteTaskDirectly(currentDetailTaskId);
  closeDetailModal();
}

function quickToggleComplete() {
  if (!currentDetailTaskId) return;
  toggleTaskComplete(currentDetailTaskId);
  openDetail(currentDetailTaskId);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'commentInput') addComment();
});

// ==================== 客户管理 ====================
let selectedClientColor = '#5b5fc7';
let editingClientId = null;

function openClientModal(clientId = null) {
  editingClientId = clientId;
  document.getElementById('clientName').value = '';
  selectedClientColor = '#5b5fc7';

  if (clientId) {
    const client = getClient(clientId);
    if (client) {
      document.getElementById('clientModalTitle').textContent = '编辑客户';
      document.getElementById('clientName').value = client.name;
      selectedClientColor = client.color;
    }
  } else {
    document.getElementById('clientModalTitle').textContent = '新增客户/项目';
  }

  document.querySelectorAll('#clientColorPicker .color-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.color === selectedClientColor);
  });
  document.getElementById('clientModal').classList.add('show');
}

function closeClientModal() {
  document.getElementById('clientModal').classList.remove('show');
  editingClientId = null;
}

function saveClient() {
  const name = document.getElementById('clientName').value.trim();
  if (!name) { showToast('请输入客户名称', 'error'); return; }

  if (editingClientId) {
    const client = getClient(editingClientId);
    if (client) { client.name = name; client.color = selectedClientColor; }
    showToast('客户已更新', 'success');
  } else {
    data.clients.push({ id: uid('c'), name, color: selectedClientColor });
    showToast('客户已添加', 'success');
  }

  saveData();
  closeClientModal();
  renderAll();
}

function deleteClient(clientId) {
  const clientTasks = data.tasks.filter(t => t.clientId === clientId);
  if (clientTasks.length > 0) {
    if (!confirm(`该客户下有 ${clientTasks.length} 个任务，删除客户将同时删除这些任务，确定继续？`)) return;
    data.tasks = data.tasks.filter(t => t.clientId !== clientId);
  } else {
    if (!confirm('确定要删除这个客户吗？')) return;
  }
  data.clients = data.clients.filter(c => c.id !== clientId);
  data.collapsedClients = data.collapsedClients.filter(id => id !== clientId);
  if (data.clients.length === 0) {
    data.clients.push({ id: uid('c'), name: '默认客户', color: '#5b5fc7' });
  }
  saveData();
  renderAll();
  showToast('客户已删除', 'warning');
}

// 颜色选择器事件绑定
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('color-option')) {
    const picker = e.target.closest('.color-picker');
    if (picker) {
      picker.querySelectorAll('.color-option').forEach(el => el.classList.remove('selected'));
      e.target.classList.add('selected');
      if (picker.id === 'clientColorPicker') {
        selectedClientColor = e.target.dataset.color;
      } else if (picker.id === 'memberColorPicker') {
        selectedMemberColor = e.target.dataset.color;
        const hiddenInput = document.getElementById('memberColor');
        if (hiddenInput) hiddenInput.value = e.target.dataset.color;
      }
    }
  }
});

// ==================== 团队成员 ====================
let selectedMemberColor = '#5b5fc7';

function renderTeam() {
  const statsContainer = document.getElementById('teamStats');
  const grid = document.getElementById('membersGrid');

  // 管理员才显示添加成员按钮
  const addMemberBtn = document.getElementById('addMemberBtn');
  if (addMemberBtn) {
    addMemberBtn.style.display = getCurrentUser().role === '管理员' ? '' : 'none';
  }

  const totalTasks = data.tasks.length;
  const doneTasks = data.tasks.filter(t => getTaskStatus(t) === 'done').length;
  const inProgressTasks = data.tasks.filter(t => getTaskStatus(t) === 'in-progress').length;
  const overdueTasks = data.tasks.filter(t => getTaskStatus(t) === 'overdue').length;

  statsContainer.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">总任务数</div>
      <div class="stat-value">${totalTasks}</div>
      <div class="stat-sub">共 ${data.clients.length} 个客户</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">已完成</div>
      <div class="stat-value" style="color:#34c759">${doneTasks}</div>
      <div class="stat-sub">完成率 ${totalTasks ? Math.round(doneTasks/totalTasks*100) : 0}%</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">进行中</div>
      <div class="stat-value" style="color:#5b5fc7">${inProgressTasks}</div>
      <div class="stat-sub">正在推进</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">已逾期</div>
      <div class="stat-value" style="color:#ff3b30">${overdueTasks}</div>
      <div class="stat-sub">需尽快处理</div>
    </div>
  `;

  grid.innerHTML = data.members.map(m => {
    const memberTasks = data.tasks.filter(t => t.assignees.includes(m.id));
    const done = memberTasks.filter(t => getTaskStatus(t) === 'done').length;
    const total = memberTasks.length;
    const progress = total ? Math.round(done / total * 100) : 0;
    const inProgress = memberTasks.filter(t => getTaskStatus(t) === 'in-progress').length;

    return `
      <div class="member-card">
        <div class="member-top">
          <div class="avatar lg" style="background:${m.color}">${getInitials(m.name)}</div>
          <div>
            <div class="member-name">${escapeHtml(m.name)}</div>
            <div class="member-role">${escapeHtml(m.role || '成员')}</div>
          </div>
          ${getCurrentUser().role === '管理员' ? `
            <div class="member-actions" style="margin-left:auto;display:flex;gap:6px;">
              <button class="client-action-btn" title="编辑成员" onclick="event.stopPropagation();openMemberModal('${m.id}')">✏️</button>
              <button class="client-action-btn" title="删除成员" onclick="event.stopPropagation();deleteMember('${m.id}')">🗑️</button>
            </div>
          ` : ''}
        </div>
        <div class="member-progress">
          <div class="progress-header">
            <span class="progress-label">任务完成进度</span>
            <span class="progress-value">${progress}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${progress}%"></div>
          </div>
        </div>
        <div class="member-stats-row">
          <div class="member-stat">
            <div class="member-stat-num">${total}</div>
            <div class="member-stat-label">总任务</div>
          </div>
          <div class="member-stat">
            <div class="member-stat-num" style="color:#34c759">${done}</div>
            <div class="member-stat-label">已完成</div>
          </div>
          <div class="member-stat">
            <div class="member-stat-num" style="color:#5b5fc7">${inProgress}</div>
            <div class="member-stat-label">进行中</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ==================== 成员管理 ====================
let editingMemberId = null;

function selectMemberColor(e) {
  const target = e.target.closest('.color-option');
  if (!target) return;
  const color = target.dataset.color;
  document.getElementById('memberColor').value = color;
  document.querySelectorAll('#memberColorPicker .color-option').forEach(el => {
    el.classList.toggle('selected', el === target);
  });
}

function openMemberModal(memberId = null) {
  editingMemberId = memberId;
  const modal = document.getElementById('memberModal');
  const title = document.getElementById('memberModalTitle');
  const saveBtn = document.getElementById('memberSaveBtn');
  if (memberId) {
    const m = getMember(memberId);
    if (!m) return;
    title.textContent = '编辑成员';
    saveBtn.textContent = '保存';
    document.getElementById('memberName').value = m.name;
    document.getElementById('memberRole').value = m.role || '组员';
    document.getElementById('memberColor').value = m.color;
    // 更新颜色选择器选中状态
    document.querySelectorAll('#memberColorPicker .color-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.color === m.color);
    });
    document.getElementById('memberPassword').value = USER_PASSWORDS[memberId] || '';
    document.getElementById('memberPassword').placeholder = '输入新密码';
  } else {
    title.textContent = '添加成员';
    saveBtn.textContent = '添加';
    document.getElementById('memberName').value = '';
    document.getElementById('memberRole').value = '组员';
    document.getElementById('memberColor').value = '#5b5fc7';
    document.querySelectorAll('#memberColorPicker .color-option').forEach(el => {
      el.classList.toggle('selected', el.dataset.color === '#5b5fc7');
    });
    document.getElementById('memberPassword').value = '';
    document.getElementById('memberPassword').placeholder = '设置登录密码';
  }
  modal.classList.add('show');
}

function closeMemberModal() {
  document.getElementById('memberModal').classList.remove('show');
  editingMemberId = null;
}

function saveMember() {
  const name = document.getElementById('memberName').value.trim();
  const role = document.getElementById('memberRole').value.trim() || '组员';
  const color = document.getElementById('memberColor').value || '#5b5fc7';
  const password = document.getElementById('memberPassword').value.trim();

  if (!name) { showToast('请输入成员姓名', 'error'); return; }
  if (!password) { showToast('请设置登录密码', 'error'); return; }

  if (editingMemberId) {
    // 编辑现有成员
    const m = getMember(editingMemberId);
    if (m) {
      m.name = name;
      m.role = role;
      m.color = color;
      USER_PASSWORDS[editingMemberId] = password;
    }
    showToast('成员已更新', 'success');
  } else {
    // 检查重名
    if (data.members.find(m => m.name === name)) {
      showToast('成员姓名已存在', 'error'); return;
    }
    const newId = uid('u');
    data.members.push({ id: newId, name, role, color });
    USER_PASSWORDS[newId] = password;
    showToast('成员已添加', 'success');
  }

  // 保存密码到 localStorage（仅本地，不同步服务器）
  localStorage.setItem('team_workbench_passwords', JSON.stringify(USER_PASSWORDS));
  saveData();
  closeMemberModal();
  renderAll();
}

function deleteMember(memberId) {
  const m = getMember(memberId);
  if (!m) return;
  // 检查是否有负责的任务
  const assignedTasks = data.tasks.filter(t => t.assignees.includes(memberId));
  if (assignedTasks.length > 0) {
    showToast(`该成员还有 ${assignedTasks.length} 个任务，请先转移或删除相关任务`, 'error');
    return;
  }
  if (!confirm(`确定要删除成员「${m.name}」吗？`)) return;

  data.members = data.members.filter(m => m.id !== memberId);
  // 同时删除密码
  delete USER_PASSWORDS[memberId];
  localStorage.setItem('team_workbench_passwords', JSON.stringify(USER_PASSWORDS));
  // 删除该用户的通知
  data.notifications = data.notifications.filter(n => n.userId !== memberId);

  saveData();
  renderAll();
  showToast('成员已删除', 'success');
}

// (old duplicate member functions removed - using enhanced version above)

// ==================== 通知 ====================
function addNotification(userId, type, taskId, text) {
  data.notifications.unshift({
    id: uid('n'), type, taskId, text,
    time: new Date().toISOString(), read: false, userId,
  });
  saveData();
  updateNotifBadge();
}

function updateNotifBadge() {
  const myUnread = data.notifications.filter(n => n.userId === data.currentUserId && !n.read).length;
  document.getElementById('notifBadge').textContent = myUnread;
  document.getElementById('notifBadge').style.display = myUnread > 0 ? 'inline-block' : 'none';
  document.getElementById('notifDot').style.display = myUnread > 0 ? 'block' : 'none';
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  const myNotifs = data.notifications.filter(n => n.userId === data.currentUserId);
  if (myNotifs.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔔</div><div class="empty-state-text">暂无通知</div></div>';
    return;
  }
  const icons = { task: '📋', comment: '💬', status: '✅', mention: '👋' };
  list.innerHTML = myNotifs.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markNotifRead('${n.id}', '${n.taskId}')">
      <div class="notif-icon ${n.type}">${icons[n.type] || '📌'}</div>
      <div class="notif-content">
        <div class="notif-text">${escapeHtml(n.text)}</div>
        <div class="notif-time">${formatDateTime(n.time)}</div>
      </div>
      ${n.read ? '' : '<div class="notif-dot"></div>'}
      <button class="notif-delete" onclick="event.stopPropagation();deleteNotification('${n.id}')" title="删除此通知">✕</button>
    </div>
  `).join('');
}

function markNotifRead(notifId, taskId) {
  const notif = data.notifications.find(n => n.id === notifId);
  if (notif) { notif.read = true; saveData(); updateNotifBadge(); renderNotifications(); }
  if (taskId) openDetail(taskId);
}

function deleteNotification(notifId) {
  data.notifications = data.notifications.filter(n => n.id !== notifId);
  saveData(); updateNotifBadge(); renderNotifications();
  showToast('通知已删除', 'success');
}

function clearAllNotifications() {
  const myNotifs = data.notifications.filter(n => n.userId === data.currentUserId);
  if (myNotifs.length === 0) { showToast('暂无通知可删除', 'info'); return; }
  if (!confirm(`确定要清空全部 ${myNotifs.length} 条通知吗？`)) return;
  data.notifications = data.notifications.filter(n => n.userId !== data.currentUserId);
  saveData(); updateNotifBadge(); renderNotifications();
  showToast('已清空全部通知', 'success');
}

function markAllRead() {
  data.notifications.forEach(n => { if (n.userId === data.currentUserId) n.read = true; });
  saveData(); updateNotifBadge(); renderNotifications();
  showToast('已全部标记为已读', 'success');
}

// ==================== 任务导入/导出 ====================
function buildTaskExportRows() {
  return data.tasks.map(t => {
    const client = getClient(t.clientId);
    const assigneeNames = (t.assignees || []).map(id => {
      const m = getMember(id);
      return m ? m.name : '';
    }).join('、');
    const creator = getMember(t.createdBy);
    return {
      '任务标题': t.title || '',
      '客户': client ? client.name : '',
      '客户细分': t.segment || '',
      '负责人': assigneeNames,
      '创建人': creator ? creator.name : '',
      '创建时间': t.createdAt ? formatDateTime(t.createdAt) : '',
      '计划日期': t.dueDate ? formatDateFull(t.dueDate) : '',
      '完成日期': t.completedDate ? formatDateFull(t.completedDate) : '',
      '当前进展': t.progress || '',
      '状态': statusConfig[getTaskStatus(t)] ? statusConfig[getTaskStatus(t)].label : '',
    };
  });
}

function exportTasksExcel() {
  if (!data.tasks.length) { showToast('暂无任务可导出', 'error'); return; }
  const rows = buildTaskExportRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  // 设置列宽
  ws['!cols'] = [
    { wch: 25 }, { wch: 15 }, { wch: 18 }, { wch: 18 }, { wch: 12 },
    { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 35 }, { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '任务清单');
  const fileName = `任务看板_${formatDateFull(new Date().toISOString())}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast(`已导出 ${rows.length} 条任务到 Excel`, 'success');
}

function exportTasksPDF() {
  if (!data.tasks.length) { showToast('暂无任务可导出', 'error'); return; }
  const rows = buildTaskExportRows();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  // 标题
  doc.setFontSize(14);
  doc.text(`任务看板 - ${formatDateFull(new Date().toISOString())}`, 40, 30);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`共 ${rows.length} 条任务 | 导出人：${getCurrentUser().name}`, 40, 46);
  doc.setTextColor(0);

  // 表格
  const headers = ['任务标题', '客户', '客户细分', '负责人', '创建人', '计划日期', '完成日期', '状态', '当前进展'];
  const body = rows.map(r => [
    r['任务标题'], r['客户'], r['客户细分'], r['负责人'], r['创建人'],
    r['计划日期'], r['完成日期'], r['状态'], r['当前进展'],
  ]);

  doc.autoTable({
    head: [headers],
    body: body,
    startY: 56,
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [91, 95, 199], textColor: 255, fontSize: 8 },
    columnStyles: {
      0: { cellWidth: 120 },
      8: { cellWidth: 150 },
    },
    didDrawPage: function(data) {
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`第 ${doc.internal.getNumberOfPages()} 页`, data.settings.margin.left, doc.internal.pageSize.height - 15);
    },
  });

  const fileName = `任务看板_${formatDateFull(new Date().toISOString())}.pdf`;
  doc.save(fileName);
  showToast(`已导出 ${rows.length} 条任务到 PDF`, 'success');
}

function importTasksExcel(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const fileBytes = new Uint8Array(e.target.result);
      const wb = XLSX.read(fileBytes, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(ws);

      if (!json.length) { showToast('Excel文件中没有数据', 'error'); return; }

      let imported = 0;
      json.forEach(row => {
        const title = (row['任务标题'] || row['标题'] || '').toString().trim();
        if (!title) return;

        // 查找或创建客户
        const clientName = (row['客户'] || '').toString().trim();
        let client = data.clients.find(c => c.name === clientName);
        if (clientName && !client) {
          client = { id: uid('c'), name: clientName, color: '#5b5fc7' };
          data.clients.push(client);
        }

        // 解析负责人
        const assigneeStr = (row['负责人'] || '').toString().trim();
        const assigneeNames = assigneeStr ? assigneeStr.split(/[、,，\s]+/).filter(Boolean) : [];
        const assignees = assigneeNames.map(name => {
          let m = data.members.find(mem => mem.name === name);
          if (!m) {
            const newId = uid('u');
            m = { id: newId, name, role: '组员', color: '#5b5fc7' };
            data.members.push(m);
          }
          return m.id;
        });

        // 解析日期
        const dueDate = (row['计划日期'] || '').toString().trim();
        const completedDate = (row['完成日期'] || '').toString().trim();

        const newTask = {
          id: uid('t'),
          title: title,
          segment: (row['客户细分'] || '').toString().trim(),
          progress: (row['当前进展'] || '').toString().trim(),
          assignees: assignees.length ? assignees : [data.currentUserId],
          clientId: client ? client.id : (data.clients[0] ? data.clients[0].id : ''),
          dueDate: dueDate,
          completedDate: completedDate,
          firstViewedBy: {},
          commentReadBy: {},
          createdAt: new Date().toISOString(),
          createdBy: data.currentUserId,
          comments: [],
          history: [],
        };
        data.tasks.push(newTask);
        imported++;
      });

      saveData();
      renderAll();
      showToast(`成功导入 ${imported} 条任务`, 'success');
    } catch (err) {
      console.error('导入失败', err);
      showToast('导入失败，请检查Excel格式', 'error');
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

// ==================== 统计图表 ====================
function renderCharts() {
  const style = getComputedStyle(document.documentElement);
  const accent = '#5b5fc7', accent2 = '#0ea5e9', muted = '#6e6e73', success = '#34c759', warning = '#ff9500', danger = '#ff3b30', rule = 'rgba(0,0,0,0.06)';

  // 状态分布
  const statusChart = echarts.init(document.getElementById('chart-status'), null, { renderer: 'svg' });
  const statusData = statusOrder.map(s => ({
    value: data.tasks.filter(t => getTaskStatus(t) === s).length,
    name: statusConfig[s].label,
    itemStyle: { color: getStatusColor(s) }
  }));
  statusChart.setOption({
    animation: false,
    tooltip: { trigger: 'item', appendToBody: true },
    legend: { bottom: 0, textStyle: { color: muted, fontSize: 12 } },
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
      label: { show: false }, emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data: statusData,
    }],
  });
  window.addEventListener('resize', () => statusChart.resize());

  // 客户任务统计
  const clientsChart = echarts.init(document.getElementById('chart-clients'), null, { renderer: 'svg' });
  const clientNames = data.clients.map(c => c.name);
  const clientTodo = data.clients.map(c => data.tasks.filter(t => t.clientId === c.id && getTaskStatus(t) === 'todo').length);
  const clientInProgress = data.clients.map(c => data.tasks.filter(t => t.clientId === c.id && getTaskStatus(t) === 'in-progress').length);
  const clientOverdue = data.clients.map(c => data.tasks.filter(t => t.clientId === c.id && getTaskStatus(t) === 'overdue').length);
  const clientDone = data.clients.map(c => data.tasks.filter(t => t.clientId === c.id && getTaskStatus(t) === 'done').length);

  clientsChart.setOption({
    animation: false,
    tooltip: { trigger: 'axis', appendToBody: true, axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { color: muted, fontSize: 12 } },
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: clientNames, axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted, fontSize: 12 } },
    yAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: rule } }, axisLabel: { color: muted, fontSize: 11 } },
    series: [
      { name: '待办', type: 'bar', stack: 'total', data: clientTodo, itemStyle: { color: muted } },
      { name: '进行中', type: 'bar', stack: 'total', data: clientInProgress, itemStyle: { color: accent } },
      { name: '逾期中', type: 'bar', stack: 'total', data: clientOverdue, itemStyle: { color: danger } },
      { name: '已完成', type: 'bar', stack: 'total', data: clientDone, itemStyle: { color: success, borderRadius: [4,4,0,0] } },
    ],
  });
  window.addEventListener('resize', () => clientsChart.resize());

  // 成员任务
  const membersChart = echarts.init(document.getElementById('chart-members'), null, { renderer: 'svg' });
  const memberNames = data.members.map(m => m.name);
  const memberDone = data.members.map(m => data.tasks.filter(t => t.assignees.includes(m.id) && getTaskStatus(t) === 'done').length);
  const memberInProgress = data.members.map(m => data.tasks.filter(t => t.assignees.includes(m.id) && getTaskStatus(t) === 'in-progress').length);
  const memberOverdue = data.members.map(m => data.tasks.filter(t => t.assignees.includes(m.id) && getTaskStatus(t) === 'overdue').length);
  const memberTodo = data.members.map(m => data.tasks.filter(t => t.assignees.includes(m.id) && getTaskStatus(t) === 'todo').length);

  membersChart.setOption({
    animation: false,
    tooltip: { trigger: 'axis', appendToBody: true, axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { color: muted, fontSize: 12 } },
    grid: { left: 40, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: memberNames, axisLine: { lineStyle: { color: rule } }, axisLabel: { color: muted, fontSize: 12 } },
    yAxis: { type: 'value', axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: rule } }, axisLabel: { color: muted, fontSize: 11 } },
    series: [
      { name: '已完成', type: 'bar', stack: 'total', data: memberDone, itemStyle: { color: success, borderRadius: [0,0,0,0] } },
      { name: '进行中', type: 'bar', stack: 'total', data: memberInProgress, itemStyle: { color: accent } },
      { name: '逾期中', type: 'bar', stack: 'total', data: memberOverdue, itemStyle: { color: danger } },
      { name: '待办', type: 'bar', stack: 'total', data: memberTodo, itemStyle: { color: muted, borderRadius: [4,4,0,0] } },
    ],
  });
  window.addEventListener('resize', () => membersChart.resize());

  // 优先级分布 - 改为客户细分分布
  const segMap = {};
  data.tasks.forEach(t => {
    const seg = t.segment || '未分类';
    if (!segMap[seg]) segMap[seg] = 0;
    segMap[seg]++;
  });
  const segChart = echarts.init(document.getElementById('chart-priority'), null, { renderer: 'svg' });
  const segNames = Object.keys(segMap);
  const segColors = ['#5b5fc7', '#0ea5e9', '#34c759', '#ff9500', '#ff3b30', '#af52de', '#ec4899'];
  segChart.setOption({
    animation: false,
    tooltip: { trigger: 'item', appendToBody: true },
    legend: { bottom: 0, textStyle: { color: muted, fontSize: 11 }, type: 'scroll' },
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
      label: { show: false }, emphasis: { label: { show: true, fontSize: 12, fontWeight: 'bold' } },
      data: segNames.map((name, i) => ({
        value: segMap[name],
        name: name,
        itemStyle: { color: segColors[i % segColors.length] }
      })),
    }],
  });
  window.addEventListener('resize', () => segChart.resize());
}

// ==================== 弹窗遮罩关闭 ====================
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('show');
      // 详情弹窗通过遮罩关闭时，也需要重新渲染看板
      if (overlay.id === 'detailModal' && currentDetailTaskId) {
        currentDetailTaskId = null;
        renderAll();
      }
    }
  });
});

// ==================== 启动 ====================
async function init() {
  // 加载遮罩已在 HTML 中默认显示
  data = await loadData();

  // 关键修复：先检查登录状态，未登录则只显示登录界面，不渲染工作台
  if (!isLoggedIn()) {
    // 隐藏加载遮罩，显示登录界面
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.add('hide');
    showLogin();
    return;
  }

  // 已登录：正常渲染工作台
  syncTaskStatuses();
  initSidebar();
  renderAll();
  // 隐藏加载遮罩
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (loadingOverlay) loadingOverlay.classList.add('hide');
  // 启动轮询同步（每15秒检查一次其他用户的更新）
  setInterval(pollSync, 5000);
}

// 防止 renderAll 在 data 加载完成前被调用
function renderAll() {
  if (!data) return;
  syncTaskStatuses();
  updatePermissionUI();
  renderKanban();
  // 恢复选中状态
  document.querySelectorAll('.task-checkbox').forEach(cb => {
    cb.checked = selectedTaskIds.has(cb.dataset.taskId);
  });
  updateBatchBar();
  renderTeam();
  renderNotifications();
  updateNotifBadge();
  updateCurrentUserDisplay();
}

// 根据权限更新UI元素显隐
function updatePermissionUI() {
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };
  show('addTaskBtnTop', hasPermission('memberCanCreateTask'));
  show('addClientBtnTop', hasPermission('memberCanAddClient'));
  show('exportExcelBtn', hasPermission('memberCanExport'));
  show('exportPdfBtn', hasPermission('memberCanExport'));
  show('importExcelBtn', hasPermission('memberCanImport'));
  // 权限设置入口仅管理员可见
  show('navPermissions', isAdmin());
  // 列宽设置入口仅管理员可见
  show('navColumnWidths', isAdmin());
}

// ==================== 权限设置面板 ====================
const permissionGroups = [
  {
    title: '任务权限',
    icon: '📋',
    items: [
      { key: 'memberCanCreateTask', label: '新建任务', desc: '允许组员创建新任务' },
      { key: 'memberCanEditTask', label: '编辑任务', desc: '允许组员编辑任务内容（不含计划日期）' },
      { key: 'memberCanEditDueDate', label: '修改计划日期', desc: '允许组员修改任务的计划完成日期' },
      { key: 'memberCanDeleteTask', label: '删除任务', desc: '允许组员删除已有任务' },
      { key: 'memberCanToggleComplete', label: '标记完成', desc: '允许组员标记任务完成或取消完成' },
    ],
  },
  {
    title: '客户管理',
    icon: '🏢',
    items: [
      { key: 'memberCanAddClient', label: '新增客户', desc: '允许组员添加新的客户分组' },
      { key: 'memberCanEditClient', label: '编辑客户', desc: '允许组员修改客户名称和颜色' },
      { key: 'memberCanDeleteClient', label: '删除客户', desc: '允许组员删除客户分组' },
    ],
  },
  {
    title: '数据导入导出',
    icon: '📦',
    items: [
      { key: 'memberCanExport', label: '导出数据', desc: '允许组员导出Excel和PDF' },
      { key: 'memberCanImport', label: '导入数据', desc: '允许组员从Excel批量导入任务' },
    ],
  },
  {
    title: '评论权限',
    icon: '💬',
    items: [
      { key: 'memberCanComment', label: '发表评论', desc: '允许组员在任务中发表评论' },
      { key: 'memberCanDeleteOwnComment', label: '删除自己评论', desc: '允许组员删除自己发表的评论' },
    ],
  },
];

function renderPermissions() {
  const container = document.getElementById('permissionsContainer');
  if (!data.permissions) data.permissions = JSON.parse(JSON.stringify(defaultPermissions));

  container.innerHTML = permissionGroups.map(group => `
    <div class="perm-group">
      <div class="perm-group-header">
        <span>${group.icon}</span> ${group.title}
      </div>
      <div class="perm-group-body">
        ${group.items.map(item => `
          <div class="perm-row">
            <div>
              <div class="perm-row-label">${item.label}</div>
              <div class="perm-row-desc">${item.desc}</div>
            </div>
            <div class="perm-toggle ${data.permissions[item.key] ? 'on' : ''}" 
                 onclick="togglePermission('${item.key}', this)" 
                 data-key="${item.key}"></div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function togglePermission(key, el) {
  const isOn = el.classList.toggle('on');
  data.permissions[key] = isOn;
}

function savePermissions() {
  saveData();
  renderAll();
  showToast('权限设置已保存并生效', 'success');
}

// ==================== 列宽设置面板 ====================
function renderColumnWidths() {
  var container = document.getElementById('columnWidthsContainer');
  if (!data.columnWidths) data.columnWidths = getDefaultColumnWidths();
  var cw = data.columnWidths;

  container.innerHTML = cw.map(function(col, idx) {
    var isPixel = col.width.indexOf('px') !== -1;
    var numVal = isPixel ? parseInt(col.width) : 200;
    var minVal = isPixel ? parseInt(col.min) : 150;
    var maxVal = isPixel ? parseInt(col.max) : 400;
    return `
      <div class="perm-row" style="padding:12px 16px">
        <div style="flex:1">
          <div class="perm-row-label">${idx + 1}. ${col.label}</div>
          <div class="perm-row-desc" style="margin-top:6px">
            <input type="range" min="${minVal}" max="${maxVal}" value="${numVal}"
              oninput="updateColumnWidth(${idx}, this.value)"
              style="width:100%;accent-color:var(--brand)">
            <span style="font-size:12px;color:var(--muted)">${col.width}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function updateColumnWidth(idx, value) {
  var cw = data.columnWidths || getDefaultColumnWidths();
  var col = cw[idx];
  if (col.width.indexOf('px') !== -1) {
    col.width = value + 'px';
  } else {
    // For fr/minmax columns, update the fr value
    col.width = 'minmax(' + value + 'px, ' + (parseInt(value) + 200) + 'px)';
  }
  // 实时更新预览
  var label = document.querySelectorAll('#columnWidthsContainer .perm-row-desc span')[idx];
  if (label) label.textContent = col.width;
  renderAll();
}

function saveColumnWidths() {
  saveData();
  showToast('列宽设置已保存并同步', 'success');
}

function resetColumnWidths() {
  data.columnWidths = getDefaultColumnWidths();
  renderColumnWidths();
  renderAll();
  showToast('已恢复默认列宽（未保存，请点击保存设置）', 'info');
}

const excelImportTasks = [{"id": "t_import_1", "title": "硅胶垫817311720-V1000A两个黑色KT侧面白色痕迹", "segment": "恒润科技", "progress": "不良验证锁定组装段造成，事故调查表待老严回复", "dueDate": "2026-05-15", "completedDate": "2026-05-15", "clientId": "c12", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_2", "title": "18004313吸塑盒过紧，验证影响因素", "segment": "BCS", "progress": "预计8.15供应商完成更改吸塑盒，小批次验证", "dueDate": "2026-08-15", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_3", "title": "8162中心轴修模事宜（总长吸水超差）", "segment": "BCS", "progress": "7.31已完成修模，邮寄3模给ken确认", "dueDate": "2026-08-15", "completedDate": "2026-08-07", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_4", "title": "8080位偏产品月底给出处理结果", "segment": "BCS", "progress": "", "dueDate": "2026-07-31", "completedDate": "2026-07-28", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_5", "title": "客诉8080字符位偏", "segment": "BCS", "progress": "", "dueDate": "2026-07-07", "completedDate": "2026-07-07", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_6", "title": "反馈8159/8074产品短装，补货", "segment": "BCS", "progress": "", "dueDate": "2026-06-29", "completedDate": "2026-06-29", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_7", "title": "售后反馈手柄面盖17048973-01表面气泡问题", "segment": "BCS", "progress": "", "dueDate": "2026-07-02", "completedDate": "2026-07-07", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_8", "title": "8079外箱标签和内箱实物不符客诉处理", "segment": "BCS", "progress": "", "dueDate": "2026-06-15", "completedDate": "2026-06-15", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_9", "title": "8653毛边LLC", "segment": "BCS", "progress": "（6.12提交→6.15退回→6.17重新提交→6.18完成）", "dueDate": "2026-06-12", "completedDate": "2026-06-18", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_10", "title": "17049868测量AAR样和投诉批次平面度差异", "segment": "BCS", "progress": "", "dueDate": "2026-06-10", "completedDate": "2026-06-10", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_11", "title": "讨论关于模具保养以及模具寿命再次验证的要求", "segment": "BCS", "progress": "待讨论", "dueDate": "2026-06-12", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_12", "title": "待工程更新8653 FMEA后更新CP、SIP", "segment": "BCS", "progress": "", "dueDate": "2026-06-08", "completedDate": "2026-06-08", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_13", "title": "理想X04 CP（3个跷跷板变种型号）", "segment": "BCS", "progress": "PE已完成，客户已临批，待后续核对更新", "dueDate": "2026-08-20", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_14", "title": "理想X04 CP（3个面盖变种型号）", "segment": "BCS", "progress": "PE已完成，客户已临批，待后续核对更新", "dueDate": "2026-08-20", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_15", "title": "起鼓投诉跟进", "segment": "BCS", "progress": "待业务与SQE商讨是否需要改模（费用问题），内部超限度样品已隔离", "dueDate": "2026-09-30", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_16", "title": "《失效质量成本协议》&《GSQM全球供应商质量手册》文件走盖章流程", "segment": "BCS", "progress": "", "dueDate": "2026-05-11", "completedDate": "2026-05-11", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_17", "title": "客诉Tray盘用错", "segment": "BCS", "progress": "", "dueDate": "2026-05-14", "completedDate": "2026-05-14", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_18", "title": "泰德兴反馈MZT0222583硅胶破损，内部已查看20模硅胶无此类不良", "segment": "泰德兴", "progress": "不良件不返回", "dueDate": "2026-08-15", "completedDate": "2026-08-05", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_19", "title": "泰德兴反馈2580按键侧面水口高出", "segment": "泰德兴", "progress": "目前新制作模具冲切后毛刺仍有超标准，待跟踪优化冲切模具", "dueDate": "2026-07-31", "completedDate": "", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_20", "title": "USI按键力值超标，询问弹片力值范围及实测值（实测166g，标准160±20g）", "segment": "泰德兴", "progress": "要求QC后续保留力值不良实物", "dueDate": "2026-12-31", "completedDate": "2026-08-05", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_21", "title": "泰德兴反馈键反问题", "segment": "泰德兴", "progress": "", "dueDate": "2026-06-29", "completedDate": "2026-06-29", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_22", "title": "缺双面胶、反离型、点胶脱落事故调查表", "segment": "泰德兴", "progress": "", "dueDate": "2026-06-05", "completedDate": "2026-06-18", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_23", "title": "拉会（产线、PE、SQE）商讨胶水压不开、双面胶缺、不离型问题", "segment": "泰德兴", "progress": "", "dueDate": "2026-06-15", "completedDate": "2026-06-12", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_24", "title": "更新下键帽脱落和胶水压不开两个问题改善措施落实情况", "segment": "泰德兴", "progress": "", "dueDate": "2026-06-20", "completedDate": "2026-06-25", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_25", "title": "泰德兴反馈的点胶脱落问题", "segment": "泰德兴", "progress": "", "dueDate": "2026-05-30", "completedDate": "2026-06-13", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_26", "title": "泰德兴反馈的反离型问题，验证提高蓝膜克重至70克", "segment": "泰德兴", "progress": "8/4泰德兴要求在此基础上降低离型力，故暂放弃增加克重方案", "dueDate": "2026-07-23", "completedDate": "2026-08-04", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_27", "title": "泰德兴反馈的缺双面胶问题，供应商采用机检+人工检后跟踪", "segment": "泰德兴", "progress": "7月6日2550双面胶已发现缺胶2粒，待持续跟踪", "dueDate": "2026-12-31", "completedDate": "2026-08-05", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_28", "title": "USI项目CP、SIP", "segment": "泰德兴", "progress": "已提出PE资料些许问题，待PE更新", "dueDate": "2026-08-20", "completedDate": "", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_29", "title": "同泰德兴沟通出货报告改成电子档", "segment": "泰德兴", "progress": "", "dueDate": "2026-05-15", "completedDate": "2026-05-07", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_30", "title": "泰德兴反馈MZT0222581产品2.40尺寸超差", "segment": "泰德兴", "progress": "", "dueDate": "2026-05-07", "completedDate": "2026-05-07", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_31", "title": "键帽位偏未测量具体数值", "segment": "泰德兴", "progress": "", "dueDate": "2026-05-14", "completedDate": "2026-05-14", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_32", "title": "硅胶毛丝未测量具体数值", "segment": "泰德兴", "progress": "暂未收集到", "dueDate": "2026-05-14", "completedDate": "2026-05-14", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_33", "title": "每批次生产需要开会分析各个不良的原因、措施落实", "segment": "泰德兴", "progress": "不良率现已恢复正常，无需通报", "dueDate": "2026-05-06", "completedDate": "2026-05-06", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_34", "title": "后续发货需准备2pcs外观不良品供客户测试使用", "segment": "共创科技", "progress": "", "dueDate": "2026-07-15", "completedDate": "2026-07-15", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_35", "title": "注塑黑色产品备注'尺寸优化'", "segment": "共创科技", "progress": "下批次生产", "dueDate": "2026-08-05", "completedDate": "2026-08-05", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_36", "title": "客寄件，要求PE做耐磨（纸带），粗字符/细字符每圈均需拍摄", "segment": "共创科技", "progress": "", "dueDate": "2026-05-12", "completedDate": "2026-05-12", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_37", "title": "同客户沟通出货报告改成电子档", "segment": "共创科技", "progress": "", "dueDate": "2026-05-08", "completedDate": "2026-05-08", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_38", "title": "小猴项目CP、SIP（丁海燕协助编写）", "segment": "共创科技", "progress": "7.21CP已提交工程，SIP上传PLM系统，部分细节待工程确认", "dueDate": "2026-06-08", "completedDate": "", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_39", "title": "应力隔离产品待共创与小猴签样后，对比放行", "segment": "共创科技", "progress": "7.22已同客户确认打磨出货", "dueDate": "2026-07-26", "completedDate": "2026-07-22", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_40", "title": "邮寄100pcs产品给共创", "segment": "共创科技", "progress": "", "dueDate": "2026-05-13", "completedDate": "2026-05-13", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_41", "title": "内侧拉模产品走报废流程", "segment": "共创科技", "progress": "", "dueDate": "2026-05-09", "completedDate": "2026-05-09", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_42", "title": "客诉产品碰伤", "segment": "共创科技", "progress": "", "dueDate": "2026-05-12", "completedDate": "2026-05-12", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_43", "title": "寄120片产品给长江驻厂，补上半年产线不良", "segment": "浙江长江", "progress": "", "dueDate": "2026-07-13", "completedDate": "2026-07-14", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_44", "title": "EHV新项目SIP", "segment": "浙江长江", "progress": "待完成", "dueDate": "2026-07-24", "completedDate": "", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_45", "title": "客户反馈CA0A62AA-50产品打螺丝，螺丝断，要求排查尺寸", "segment": "浙江长江", "progress": "尺寸无异常", "dueDate": "2026-07-08", "completedDate": "2026-07-08", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_46", "title": "梳理内部反馈原模手感重（力值超标）时间线", "segment": "浙江长江", "progress": "", "dueDate": "2026-06-10", "completedDate": "2026-06-10", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_47", "title": "更新老项目SIP，调整测量力值频率", "segment": "浙江长江", "progress": "", "dueDate": "2026-06-11", "completedDate": "2026-06-12", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_48", "title": "检查反馈原模手感重（力值超标），内部分析调查", "segment": "浙江长江", "progress": "", "dueDate": "2026-06-09", "completedDate": "2026-06-09", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_49", "title": "OA申请质量保证函盖章", "segment": "浙江长江", "progress": "", "dueDate": "2026-06-04", "completedDate": "2026-06-04", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_50", "title": "EHV新项目CP", "segment": "浙江长江", "progress": "", "dueDate": "2026-05-18", "completedDate": "2026-05-20", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_51", "title": "同客户沟通出货报告改成电子档", "segment": "浙江长江", "progress": "", "dueDate": "2026-05-15", "completedDate": "2026-05-12", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_52", "title": "跟踪供应商气泡问题分析进度、跟线验证结果", "segment": "上海泽久", "progress": "7.28供应商已提供样漆，待内部喷涂试验", "dueDate": "2026-07-17", "completedDate": "", "clientId": "c7", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_53", "title": "客诉断裂、颗粒、磕伤分析报告", "segment": "上海泽久", "progress": "7.20已提交印度客户，重新梳理回复客户", "dueDate": "2026-07-13", "completedDate": "2026-08-01", "clientId": "c7", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_54", "title": "同客户沟通出货报告改成电子档", "segment": "上海泽久", "progress": "", "dueDate": "2026-05-15", "completedDate": "2026-05-15", "clientId": "c7", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_55", "title": "下班前将各客户COA如何提供整理后回复QA", "segment": "长春HELLA", "progress": "", "dueDate": "2026-05-16", "completedDate": "2026-05-16", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_56", "title": "同客户沟通出货报告改成电子档", "segment": "长春HELLA", "progress": "暂未回复，SQE回复内部沟通下", "dueDate": "2026-05-15", "completedDate": "2026-05-15", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_57", "title": "221.425-51印刷换场地，要求工程变更（暂未确定新场地）", "segment": "上海HELLA", "progress": "8/5前组织会议：工程、产线、业务、品管", "dueDate": "2026-08-05", "completedDate": "2026-08-05", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_58", "title": "HELLA反馈221.428-51表面颗粒---待跟进重检结果，评估是否算检查漏检", "segment": "上海HELLA", "progress": "", "dueDate": "2026-06-29", "completedDate": "2026-06-29", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_59", "title": "更新221.428-52 SIP 毛边标准", "segment": "上海HELLA", "progress": "", "dueDate": "2026-06-15", "completedDate": "2026-06-15", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_60", "title": "新签221.428-51划伤限度样，需通知Jonny首次实施时间、发货批次号、断点标识、数量", "segment": "上海HELLA", "progress": "", "dueDate": "2026-06-03", "completedDate": "2026-06-03", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_61", "title": "捷达年度测试", "segment": "上海HELLA", "progress": "待业务刘经理通知外发测试（TL226测试内部摸底合格）", "dueDate": "2026-12-31", "completedDate": "", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_62", "title": "京瓷质量手册培训（丁海燕协助处理）", "segment": "京瓷", "progress": "", "dueDate": "2026-06-12", "completedDate": "2026-06-22", "clientId": "c2", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_63", "title": "年度审核", "segment": "京瓷", "progress": "", "dueDate": "2026-05-13", "completedDate": "2026-05-13", "clientId": "c2", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_64", "title": "同客户沟通出货报告改成电子档", "segment": "京瓷", "progress": "", "dueDate": "2026-05-15", "completedDate": "2026-05-08", "clientId": "c2", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_65", "title": "10个型号原料、包装的环境有害物质调查", "segment": "京瓷", "progress": "", "dueDate": "2026-04-30", "completedDate": "2026-04-30", "clientId": "c2", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_66", "title": "墨西哥A3C0947710000隔离品追踪", "segment": "墨西哥欧摩威", "progress": "报废", "dueDate": "2026-07-24", "completedDate": "2026-07-23", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_67", "title": "PZ1A和PZ1D各型号组装成品收集（各2pcs）", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "待收集", "dueDate": "2026-08-29", "completedDate": "", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_68", "title": "塑料检查作业指导书更新", "segment": "长春欧摩威", "progress": "待完成", "dueDate": "2026-07-08", "completedDate": "2026-07-07", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_69", "title": "A3C0499950000红色版本SIP更新", "segment": "长春欧摩威", "progress": "待更新", "dueDate": "2026-07-02", "completedDate": "2026-07-02", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_70", "title": "PZ1D slc系统更新", "segment": "长春欧摩威", "progress": "待完成", "dueDate": "2026-07-02", "completedDate": "2026-07-02", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_71", "title": "PZ1A SIP再次更新待下发", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "待下发", "dueDate": "2026-07-10", "completedDate": "2026-07-10", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_72", "title": "支架及电池盖换包装验证", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "持续进行（降本增效项目）", "dueDate": "2026-09-19", "completedDate": "", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_73", "title": "支架及电池盖内部改包装，制定验证时间计划", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "待制定", "dueDate": "2026-07-04", "completedDate": "2026-07-03", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_74", "title": "支架SIP更新记录排查，针对毛边检测方式确认更新支架SIP", "segment": "长春欧摩威", "progress": "待完成", "dueDate": "2026-06-30", "completedDate": "2026-07-02", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_75", "title": "8400比照AAR样复制", "segment": "长春欧摩威", "progress": "待完成", "dueDate": "2026-06-30", "completedDate": "2026-06-30", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_76", "title": "PZ1A限度样同PE复制给QC", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "持续进行", "dueDate": "2026-08-31", "completedDate": "", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_77", "title": "PZ1A工程规范待工程更新后更新SIP，上传至系统", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "待工程更新", "dueDate": "2026-07-23", "completedDate": "2026-07-22", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_78", "title": "尾门键A3C0157010000-1尺寸公差跟进", "segment": "长春欧摩威", "progress": "PE回复6月底更新EC，周燕", "dueDate": "2026-08-15", "completedDate": "", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_79", "title": "SLC提交AAA2787310000出150片、AAA2787320000出700片", "segment": "长春欧摩威", "progress": "待完成", "dueDate": "2026-06-22", "completedDate": "2026-06-22", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_80", "title": "8600支架尺寸放差", "segment": "长春欧摩威", "progress": "施玥6.9更新", "dueDate": "2026-06-09", "completedDate": "2026-06-09", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_81", "title": "电镀件功能测试准备产品", "segment": "长春欧摩威", "progress": "25号已寄出给实验室", "dueDate": "2026-06-19", "completedDate": "2026-06-17", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_82", "title": "A3C0157070000/A3C0747600000后段QC反馈间隙测量频次不符", "segment": "长春欧摩威", "progress": "待跟进", "dueDate": "2026-06-02", "completedDate": "2026-06-01", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_83", "title": "PZ1A产品翻转测试验证", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "待验证", "dueDate": "2026-06-04", "completedDate": "2026-06-03", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_84", "title": "墨西哥A3C1210570000产品散落问题跟进", "segment": "墨西哥欧摩威", "progress": "待跟进（包装方式更改未得到确认）", "dueDate": "2026-05-25", "completedDate": "", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_85", "title": "8D继续修改更新", "segment": "长春欧摩威", "progress": "26/5/23", "dueDate": "2026-05-23", "completedDate": "2026-05-22", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_86", "title": "长春电镀件A3C0156940000字符旁筋条粗细不一（批号20260510-3A）", "segment": "长春欧摩威", "progress": "葛利兴重新提供23年5月份原始图，汇总整理7/4", "dueDate": "2026-06-20", "completedDate": "2026-06-19", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_87", "title": "4月份产品审核点更改", "segment": "墨西哥欧摩威", "progress": "已完成", "dueDate": "2026-05-11", "completedDate": "2026-05-09", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_88", "title": "选个型号8d报告编制", "segment": "长春欧摩威", "progress": "", "dueDate": "2026-05-12", "completedDate": "2026-05-12", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_89", "title": "7600墨西哥cp/SIP核对", "segment": "墨西哥欧摩威", "progress": "SIP 5/8重新下发、CP5/8上午发袁蕾", "dueDate": "2026-05-08", "completedDate": "2026-05-08", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_90", "title": "plm中的墨西哥SIP施玥还没点", "segment": "墨西哥欧摩威", "progress": "5.11提醒", "dueDate": "2026-05-12", "completedDate": "2026-05-12", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_91", "title": "2009979客诉柱子缺料", "segment": "Merit", "progress": "待处理", "dueDate": "2026-08-05", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_92", "title": "VCTC/PUSH项目CP", "segment": "Merit", "progress": "待完成", "dueDate": "2026-08-10", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_93", "title": "外观判定标准汇总", "segment": "Merit", "progress": "已完成", "dueDate": "2026-07-17", "completedDate": "2026-07-17", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_94", "title": "J4U待工程规范更新后下发SIP", "segment": "Merit", "progress": "张天一", "dueDate": "2026-08-08", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_95", "title": "2009979测试项更新-更新CP及SIP", "segment": "Merit", "progress": "待完成", "dueDate": "2026-05-23", "completedDate": "2026-05-23", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_96", "title": "跟客户确认出货报告改电子档", "segment": "Merit", "progress": "客户要求MERIT出货附纸质报告", "dueDate": "2026-05-21", "completedDate": "2026-05-21", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_97", "title": "英业达出货系统SOP制作", "segment": "顺铨", "progress": "待完成", "dueDate": "2026-05-15", "completedDate": "2026-05-15", "clientId": "c9", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_98", "title": "出货报告HSF", "segment": "和硕", "progress": "待完成", "dueDate": "2026-06-18", "completedDate": "2026-06-18", "clientId": "c11", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_99", "title": "XRF報告上传", "segment": "和硕", "progress": "待完成", "dueDate": "2026-06-20", "completedDate": "2026-06-20", "clientId": "c11", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_100", "title": "出货资料上传", "segment": "和硕", "progress": "待完成", "dueDate": "2026-07-02", "completedDate": "2026-07-02", "clientId": "c11", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_101", "title": "和硕环保资料上传", "segment": "和硕", "progress": "已完成reach253和CA65，还剩composition待浦燕确认", "dueDate": "2026-07-08", "completedDate": "2026-07-08", "clientId": "c11", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_102", "title": "立胜2184色差问题", "segment": "BCS", "progress": "超限度样产品隔离中", "dueDate": "2026-09-05", "completedDate": "", "clientId": "c4", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_103", "title": "6月份产品审核（塑料件AUMOVIO Mexico/长春）", "segment": "其他", "progress": "待完成", "dueDate": "2026-06-23", "completedDate": "2026-06-23", "clientId": "c13", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_104", "title": "5月份产品审核", "segment": "其他", "progress": "待完成", "dueDate": "2026-05-26", "completedDate": "2026-05-26", "clientId": "c13", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_105", "title": "QMS外审需提供的资料（积分卡、对外客诉）", "segment": "其他", "progress": "", "dueDate": "2026-07-14", "completedDate": "2026-07-14", "clientId": "c13", "assignees": ["u1"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_106", "title": "三菱2个上壳组装SIP更新：增加了按键推拉力测试，SIP待下发", "segment": "长春欧摩威, 墨西哥欧摩威", "progress": "", "dueDate": "2026-07-31", "completedDate": "2026-07-31", "clientId": "c8", "assignees": ["u2"], "createdAt": "2026-07-29T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_107", "title": "泰德兴反馈MZT0222579硅胶破损", "segment": "泰德兴", "progress": "抽检硅胶半成品，发现固定穴破损，移交硅胶QE处理", "dueDate": "2026-08-05", "completedDate": "2026-08-01", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_108", "title": "客诉灰色小猴产品边缘磕伤", "segment": "共创科技", "progress": "", "dueDate": "2026-08-05", "completedDate": "2026-08-05", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_109", "title": "原模隔离品按压手感后，抽检力值后评审", "segment": "浙江长江", "progress": "", "dueDate": "2026-07-28", "completedDate": "2026-08-03", "clientId": "c6", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_110", "title": "客诉J-2820-00-02进胶点高，内部调查回复报告", "segment": "上海泽久", "progress": "", "dueDate": "2026-08-09", "completedDate": "", "clientId": "c7", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_111", "title": "18004313吸塑盒紧LLC", "segment": "BCS", "progress": "", "dueDate": "2026-08-28", "completedDate": "", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_112", "title": "外审 雷诺18004313 CP/SIP核对下发（丁海燕协助）", "segment": "BCS", "progress": "", "dueDate": "2026-08-07", "completedDate": "2026-08-07", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_113", "title": "2184色差客退挑选，抽检色差", "segment": "BCS", "progress": "", "dueDate": "2026-07-20", "completedDate": "2026-07-28", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_114", "title": "烧焦缺料修模待客户确认", "segment": "Merit", "progress": "待客户确认", "dueDate": "2026-08-05", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-07-31T00:00:00", "createdBy": "u2", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_115", "title": "J4U_sip疑问点沟通", "segment": "Merit", "progress": "待工程回复", "dueDate": "2026-08-05", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-08-04T00:00:00", "createdBy": "u2", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_116", "title": "2015707/2015709膜厚更新内控(由15-25μm更新为21-25μm（内控）)，改SIP", "segment": "Merit", "progress": "", "dueDate": "2026-08-07", "completedDate": "", "clientId": "c10", "assignees": ["u2"], "createdAt": "2026-08-05T00:00:00", "createdBy": "u2", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_117", "title": "8/3出货 XRF待上传", "segment": "和硕", "progress": "", "dueDate": "2026-08-06", "completedDate": "", "clientId": "c11", "assignees": ["u2"], "createdAt": "2026-08-05T00:00:00", "createdBy": "u2", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_118", "title": "泰德兴反馈MZT0222578点胶脱落", "segment": "泰德兴", "progress": "", "dueDate": "2026-08-16", "completedDate": "", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-08-05T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_119", "title": "客户反馈18004313-01亮痕，调查回复排查报告", "segment": "BCS", "progress": "", "dueDate": "2026-08-09", "completedDate": "2026-08-07", "clientId": "c4", "assignees": ["u1"], "createdAt": "2026-08-05T00:00:00", "createdBy": "u1", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_121", "title": "继续跟进关注此事", "segment": "上海HELLA", "progress": "", "dueDate": "2026-08-31", "completedDate": "", "clientId": "c1", "assignees": ["u1"], "createdAt": "2026-08-07T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_122", "title": "组织更新包装方案（手拆导致亮印问题）", "segment": "共创科技", "progress": "", "dueDate": "2026-08-13", "completedDate": "", "clientId": "c5", "assignees": ["u1"], "createdAt": "2026-08-07T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_123", "title": "再跟进一份邮件给客户，询问下不良件快递情况？", "segment": "上海泽久", "progress": "", "dueDate": "2026-08-08", "completedDate": "2026-08-07", "clientId": "c7", "assignees": ["u1"], "createdAt": "2026-08-07T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}, {"id": "t_import_124", "title": "换回履带式清洗机；硅胶二次熟化改用日本东洋烘箱", "segment": "泰德兴", "progress": "", "dueDate": "2026-08-14", "completedDate": "", "clientId": "c3", "assignees": ["u1"], "createdAt": "2026-08-10T00:00:00", "createdBy": "u3", "firstViewedAt": null, "commentReadBy": {}, "comments": [], "history": []}];
// Debug: expose data for testing
window.__debugApp = function() {
  return {
    currentUserId: data ? data.currentUserId : 'null',
    storageUserId: getCurrentUserId(),
    taskCount: data ? data.tasks.length : 0,
    tasks: data ? data.tasks.map(function(t) {
      return {
        id: t.id, title: t.title.substring(0, 20),
        createdBy: t.createdBy,
        assignees: t.assignees,
        firstViewedBy: t.firstViewedBy,
        firstViewedAt: t.firstViewedAt,
        computedStatus: getTaskStatus(t)
      };
    }) : []
  };
};

init();
