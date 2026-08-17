// ==================== 数据存储层（MantleDB 云端同步 + 本地缓存） ====================
// 使用 MantleDB 作为云端 JSON 存储，支持跨电脑同步
// localStorage 作为本地缓存（优先加载），MantleDB 作为跨设备同步通道
const STORAGE_KEY = 'team_workbench_user';
const LOCAL_DATA_KEY = 'team_workbench_local_data';
const CLOUD_DATA_PATH = 'https://mantledb.sh/v2/team-workbench-v2/data';

// 带缓存清除的 fetch 封装
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

// 从 localStorage 加载本地缓存
function loadLocalData() {
  try {
    var raw = localStorage.getItem(LOCAL_DATA_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.tasks && parsed.members && parsed.clients) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('读取本地缓存失败:', e);
  }
  return null;
}

// 保存数据到 localStorage 缓存
function saveLocalData(d) {
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
  } catch (e) {
    console.warn('保存本地缓存失败:', e);
  }
}

// 当前用户身份保存在 localStorage（每人独立）
function getCurrentUserId() {
  return localStorage.getItem(STORAGE_KEY) || null;
}

function setCurrentUserId(id) {
  localStorage.setItem(STORAGE_KEY, id);
}

var data = null;
var lastSyncTime = 0;
var isSaving = false;
var serverDataLoaded = false;
var saveTimer = null;
var deletedTaskIds = new Set();

// 统一数据迁移函数
function normalizeData(d) {
  if (!d.tasks) d.tasks = [];
  d.tasks.forEach(function(t) {
    if (['expected', 'overdue-done', 'review'].indexOf(t.status) !== -1) t.status = 'in-progress';
    if (t.firstViewedBy === undefined) {
      if (t.firstViewedAt) {
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
  if (!d.members) d.members = [];
  if (!d.notifications) d.notifications = [];
  if (!d.permissions) d.permissions = JSON.parse(JSON.stringify(defaultPermissions));
  return d;
}

// 创建数据快照
function makeSnapshot(d) {
  return JSON.stringify({
    tasks: d.tasks,
    clients: d.clients,
    members: d.members,
    notifications: d.notifications,
  });
}

// 构建标准数据对象
function buildParsedData(rawData) {
  var parsed = {
    tasks: rawData.tasks || [],
    members: rawData.members || defaultData.members,
    clients: rawData.clients || defaultData.clients,
    permissions: rawData.permissions || JSON.parse(JSON.stringify(defaultPermissions)),
    notifications: rawData.notifications || [],
  };
  normalizeData(parsed);
  parsed.currentUserId = getCurrentUserId();
  if (!parsed.collapsedClients) parsed.collapsedClients = rawData.collapsedClients || [];
  return parsed;
}

// 检查云端数据是否有效
function isValidCloudData(d) {
  return d && (d.tasks || d.members || d.clients);
}

// ==================== 数据加载（本地优先，云端同步） ====================
async function loadData() {
  // 1. 优先从 localStorage 加载（最快，用户最近修改的数据）
  var localData = loadLocalData();
  if (localData && localData.tasks && localData.tasks.length > 0) {
    var parsed = buildParsedData(localData);
    lastDataSnapshot = makeSnapshot(parsed);
    serverDataLoaded = true;
    console.log('从本地缓存加载: ' + parsed.tasks.length + ' 条任务');
    // 后台同步到云端（确保其他设备能看到最新数据）
    setTimeout(function() { syncToCloudIfNeeded(parsed); }, 2000);
    return parsed;
  }

  // 2. 从 MantleDB 云端加载
  try {
    var res = await fetch(CLOUD_DATA_PATH + '?_t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) {
      var cloudData = await res.json();
      if (isValidCloudData(cloudData) && cloudData.tasks && cloudData.tasks.length > 0) {
        var parsed = buildParsedData(cloudData);
        saveLocalData(parsed);
        lastDataSnapshot = makeSnapshot(parsed);
        serverDataLoaded = true;
        console.log('从 MantleDB 云端加载: ' + parsed.tasks.length + ' 条任务');
        return parsed;
      }
    }
  } catch (e) {
    console.warn('GitHub 云端加载失败:', e.message);
  }

  // 3. 从静态 JSON 文件加载
  try {
    var res2 = await fetch('data/shared-data.json?_t=' + Date.now(), { cache: 'no-store' });
    if (res2.ok) {
      var staticData = await res2.json();
      if (isValidCloudData(staticData)) {
        var parsed = buildParsedData(staticData);
        saveLocalData(parsed);
        lastDataSnapshot = makeSnapshot(parsed);
        serverDataLoaded = true;
        console.log('从静态文件加载: ' + parsed.tasks.length + ' 条任务');
        return parsed;
      }
    }
  } catch (e) {
    console.warn('静态文件加载失败:', e.message);
  }

  // 4. 兜底默认数据
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
  console.log('使用默认数据（无任务）');
  return fallback;
}

// 后台同步到云端（仅在本地有数据且云端无数据时）
var cloudSyncInProgress = false;
async function syncToCloudIfNeeded(d) {
  if (cloudSyncInProgress) return;
  cloudSyncInProgress = true;
  try {
    var checkRes = await fetch(CLOUD_DATA_PATH + '?_t=' + Date.now(), { cache: 'no-store' });
    if (checkRes.ok) {
      var cloudData = await checkRes.json();
      if (isValidCloudData(cloudData) && cloudData.tasks && cloudData.tasks.length > 0) {
        cloudSyncInProgress = false;
        return;
      }
    }
    await saveToCloud(d);
  } catch (e) {
    console.warn('后台同步失败:', e.message);
  }
  cloudSyncInProgress = false;
}

// 保存数据到 MantleDB 云端
async function saveToCloud(d) {
  try {
    var syncData = JSON.parse(JSON.stringify(d));
    delete syncData.currentUserId;
    delete syncData.collapsedClients;

    var saveRes = await fetch(CLOUD_DATA_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(syncData),
    });

    if (saveRes.ok) {
      lastSyncTime = Date.now();
      lastDataSnapshot = makeSnapshot(syncData);
      console.log('已同步到云端: ' + syncData.tasks.length + ' 条任务');
    } else {
      console.warn('云端保存失败: ' + saveRes.status);
    }
  } catch (e) {
    console.warn('云端保存异常:', e.message);
  }
}

// ==================== 保存数据 ====================
function saveData() {
  if (!serverDataLoaded) {
    console.warn('数据未加载完成，跳过保存');
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    saveTimer = null;
    saveDataInternal();
  }, 500);
}

async function saveDataInternal() {
  if (!data) return;
  setCurrentUserId(data.currentUserId);
  if (isSaving) {
    if (!saveTimer) {
      saveTimer = setTimeout(function() { saveTimer = null; saveDataInternal(); }, 500);
    }
    return;
  }
  isSaving = true;
  try {
    // 1. 保存到本地缓存（快速、可靠）
    saveLocalData(data);

    // 2. 保存到 MantleDB 云端（跨电脑同步）
    await saveToCloud(data);
  } catch (e) {
    console.error('保存异常:', e.message);
  } finally {
    isSaving = false;
  }
}

// ==================== 轮询云端同步 ====================
var lastDataSnapshot = '';
var lastPollTime = 0;
async function pollSync() {
  if (!serverDataLoaded) return;
  if (isSaving) return;
  if (saveTimer) return;
  if (document.querySelector('.modal.show')) return;

  var now = Date.now();
  if (now - lastPollTime < 15000) return; // 至少间隔15秒
  lastPollTime = now;

  try {
    var res = await fetch(CLOUD_DATA_PATH + '?_t=' + now, { cache: 'no-store' });
    if (!res.ok) return;
    var cloudData = await res.json();
    if (!isValidCloudData(cloudData) || !cloudData.tasks) return;

    var snapshot = JSON.stringify({
      tasks: cloudData.tasks,
      members: cloudData.members,
      clients: cloudData.clients,
      notifications: cloudData.notifications,
    });

    if (snapshot !== lastDataSnapshot) {
      var currentUserId = data.currentUserId;
      var collapsedClients = data.collapsedClients;
      var parsed = buildParsedData(cloudData);
      data = parsed;
      data.currentUserId = currentUserId;
      data.collapsedClients = collapsedClients || [];
      lastDataSnapshot = snapshot;
      saveLocalData(data);
      syncTaskStatuses();
      renderAll();
      console.log('检测到云端更新，已同步: ' + parsed.tasks.length + ' 条任务');
    }
  } catch (e) {
    // 静默失败
  }
}

// ==================== 权限设置 ====================
var defaultPermissions = {
  memberCanCreateTask: true,
  memberCanEditTask: true,
  memberCanEditDueDate: false,
  memberCanDeleteTask: false,
  memberCanToggleComplete: true,
  memberCanAddClient: false,
  memberCanEditClient: false,
  memberCanDeleteClient: false,
  memberCanExport: true,
  memberCanImport: false,
  memberCanComment: true,
  memberCanDeleteOwnComment: true,
};

function isAdmin() {
  var u = getCurrentUser();
  return u && u.role === '管理员';
}

function hasPermission(key) {
  if (isAdmin()) return true;
  if (!data.permissions) return true;
  return !!data.permissions[key];
}

// ==================== 默认数据 ====================
var defaultData = {
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
    { id: 'c10', name: 'Merit', color: '#ff9500' },
    { id: 'c11', name: '和硕', color: '#ff3b30' },
    { id: 'c12', name: '恒润科技', color: '#af52de' },
    { id: 'c13', name: '其他', color: '#a1a1a6' },
  ],
};

// ==================== 用户相关 ====================
function getCurrentUser() {
  if (!data || !data.members) return null;
  var uid = getCurrentUserId();
  if (!uid) return null;
  for (var i = 0; i < data.members.length; i++) {
    if (data.members[i].id === uid) return data.members[i];
  }
  return null;
}

// ==================== 任务状态计算 ====================
function syncTaskStatuses() {
  if (!data || !data.tasks) return;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  data.tasks.forEach(function(t) {
    if (t.completedDate) {
      t.status = 'done';
      return;
    }
    if (t.dueDate) {
      var due = new Date(t.dueDate + 'T00:00:00');
      if (due < today) {
        t.status = 'overdue';
        return;
      }
    }
    t.status = 'in-progress';
  });
}

function getTaskStatus(t) {
  if (t.completedDate) return 'done';
  if (!t.dueDate) return 'in-progress';
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var due = new Date(t.dueDate + 'T00:00:00');
  if (due < today) return 'overdue';
  return 'in-progress';
}

// ==================== 通知系统 ====================
function addNotification(taskId, type, text, targetUserId) {
  if (!data.notifications) data.notifications = [];
  var n = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    type: type,
    taskId: taskId,
    text: text,
    time: new Date().toISOString(),
    read: false,
    userId: targetUserId,
  };
  data.notifications.unshift(n);
  if (data.notifications.length > 100) data.notifications.length = 100;
  saveData();
  renderNotifications();
}

function getUnreadCount() {
  if (!data || !data.notifications) return 0;
  var uid = getCurrentUserId();
  return data.notifications.filter(function(n) { return !n.read && n.userId === uid; }).length;
}

function markAllNotificationsRead() {
  if (!data.notifications) return;
  var uid = getCurrentUserId();
  data.notifications.forEach(function(n) {
    if (n.userId === uid) n.read = true;
  });
  saveData();
  renderNotifications();
}

// ==================== 渲染函数占位 ====================
function renderAll() {
  renderHeader();
  renderSidebar();
  renderKanban();
  renderNotifications();
  renderUserMenu();
}

function renderHeader() {
  var unread = getUnreadCount();
  var badge = document.getElementById('notificationBadge');
  if (badge) {
    badge.textContent = unread;
    badge.style.display = unread > 0 ? 'flex' : 'none';
  }
}

function renderSidebar() {
  var userEl = document.getElementById('currentUserName');
  var avatarEl = document.getElementById('currentUserAvatar');
  var roleEl = document.querySelector('.user-role');
  var user = getCurrentUser();
  if (userEl) {
    userEl.textContent = user ? user.name : '未登录';
  }
  if (avatarEl) {
    avatarEl.textContent = user ? user.name.charAt(0) : '?';
    avatarEl.style.background = user ? user.color : '#a1a1a6';
  }
  if (roleEl) {
    roleEl.textContent = user ? (user.role === '管理员' ? '点击管理' : '点击登录管理') : '点击登录管理';
  }
}

function renderNotifications() {
  var list = document.getElementById('notificationList');
  var count = document.getElementById('notificationCount');
  if (!list) return;
  var uid = getCurrentUserId();
  if (!data || !data.notifications) {
    list.innerHTML = '<div class="notification-empty">暂无通知</div>';
    if (count) count.textContent = '0';
    return;
  }
  var userNotifs = data.notifications.filter(function(n) { return n.userId === uid; });
  if (count) count.textContent = userNotifs.filter(function(n) { return !n.read; }).length;
  if (userNotifs.length === 0) {
    list.innerHTML = '<div class="notification-empty">暂无通知</div>';
    return;
  }
  list.innerHTML = userNotifs.slice(0, 20).map(function(n) {
    var icon = n.type === 'comment' ? '💬' : n.type === 'status' ? '✅' : '📋';
    var cls = n.read ? '' : 'unread';
    return '<div class="notification-item ' + cls + '"><span class="notification-icon">' + icon + '</span><div class="notification-content"><div class="notification-text">' + n.text + '</div><div class="notification-time">' + formatTime(n.time) + '</div></div></div>';
  }).join('');
}

function formatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var now = new Date();
  var diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return m + '/' + day;
}

function renderUserMenu() {
  var status = document.getElementById('userMenuStatus');
  if (!status) return;
  var user = getCurrentUser();
  if (user) {
    status.innerHTML = '<div class="user-menu-avatar" style="background:' + user.color + '">' + user.name.charAt(0) + '</div><div class="user-menu-info"><div class="user-menu-name">' + user.name + '</div><div class="user-menu-role-text">' + user.role + '</div></div>';
  } else {
    status.innerHTML = '<div class="user-menu-avatar" style="background:#a1a1a6">?</div><div class="user-menu-info"><div class="user-menu-name">未登录</div><div class="user-menu-role-text">请选择账号登录</div></div>';
  }
  var loginBtn = document.getElementById('userMenuLoginBtn');
  var logoutBtn = document.getElementById('userMenuLogoutBtn');
  if (loginBtn) loginBtn.style.display = user ? 'none' : 'flex';
  if (logoutBtn) logoutBtn.style.display = user ? 'flex' : 'none';
  renderUserMenuMemberList();
}

function renderUserMenuMemberList() {
  var list = document.getElementById('userMenuMemberList');
  if (!list || !data || !data.members) return;
  var currentId = getCurrentUserId();
  list.innerHTML = data.members.map(function(m) {
    var isActive = currentId === m.id;
    return '<div class="user-menu-member' + (isActive ? ' active' : '') + '" onclick="switchToUser(\'' + m.id + '\')" title="切换到' + m.name + '"><div class="user-menu-member-avatar" style="background:' + m.color + '">' + m.name.charAt(0) + '</div><div class="user-menu-member-name">' + m.name + '</div><div class="user-menu-member-role">' + m.role + '</div>' + (isActive ? '<div class="user-menu-member-check">✓</div>' : '') + '</div>';
  }).join('');
}

// ==================== 看板渲染 ====================
function renderKanban() {
  var container = document.getElementById('kanbanContainer');
  if (!container || !data) return;

  if (!data.tasks || data.tasks.length === 0) {
    container.innerHTML = '<div class="kanban-empty"><div class="kanban-empty-icon">📋</div><div class="kanban-empty-text">暂无任务</div><div class="kanban-empty-hint">点击右上角按钮导入任务，或点击 + 新建任务</div></div>';
    return;
  }

  syncTaskStatuses();
  var clients = data.clients || [];
  var collapsed = data.collapsedClients || [];

  // 按客户分组
  var clientGroups = {};
  clients.forEach(function(c) { clientGroups[c.id] = { client: c, tasks: [] }; });
  data.tasks.forEach(function(t) {
    var cid = t.clientId || 'c13';
    if (!clientGroups[cid]) {
      clientGroups[cid] = { client: clients.find(function(c) { return c.id === cid; }) || { id: cid, name: '其他', color: '#a1a1a6' }, tasks: [] };
    }
    clientGroups[cid].tasks.push(t);
  });

  var html = '';
  var sortedClients = clients.slice().sort(function(a, b) {
    return (a.name === '其他' ? 1 : 0) - (b.name === '其他' ? 1 : 0);
  });

  sortedClients.forEach(function(c) {
    var group = clientGroups[c.id];
    if (!group || group.tasks.length === 0) return;
    var isCollapsed = collapsed.indexOf(c.id) !== -1;
    var tasks = group.tasks;
    var overdueCount = tasks.filter(function(t) { return getTaskStatus(t) === 'overdue'; }).length;
    var doneCount = tasks.filter(function(t) { return getTaskStatus(t) === 'done'; }).length;
    var inProgressCount = tasks.length - overdueCount - doneCount;

    html += '<div class="client-group" data-client-id="' + c.id + '">';
    html += '<div class="client-group-header" onclick="toggleClientGroup(\'' + c.id + '\')">';
    html += '<div class="client-group-left">';
    html += '<span class="client-group-arrow" style="transform:' + (isCollapsed ? 'rotate(-90deg)' : 'rotate(0)') + '">▾</span>';
    html += '<span class="client-group-dot" style="background:' + c.color + '"></span>';
    html += '<span class="client-group-name">' + c.name + '</span>';
    html += '<span class="client-group-count">' + tasks.length + '</span>';
    html += '</div>';
    html += '<div class="client-group-stats">';
    if (overdueCount > 0) html += '<span class="stat-badge stat-overdue">' + overdueCount + ' 逾期</span>';
    if (inProgressCount > 0) html += '<span class="stat-badge stat-progress">' + inProgressCount + ' 进行中</span>';
    if (doneCount > 0) html += '<span class="stat-badge stat-done">' + doneCount + ' 已完成</span>';
    html += '</div></div>';

    if (!isCollapsed) {
      html += '<div class="client-group-tasks">';
      tasks.forEach(function(t) {
        var status = getTaskStatus(t);
        var statusLabel = status === 'overdue' ? '逾期' : status === 'done' ? '已完成' : '进行中';
        var statusClass = status === 'overdue' ? 'overdue' : status === 'done' ? 'done' : 'in-progress';
        var assigneeNames = (t.assignees || []).map(function(aid) {
          var m = data.members.find(function(m) { return m.id === aid; });
          return m ? m.name : aid;
        }).join(', ');
        var isNew = !t.firstViewedBy || Object.keys(t.firstViewedBy).length === 0;
        var newBadge = isNew ? '<span class="task-badge-new">新</span>' : '';

        html += '<div class="task-card ' + statusClass + '" onclick="openTaskDetail(\'' + t.id + '\')">';
        html += '<div class="task-card-header">';
        html += '<span class="task-status-dot ' + statusClass + '"></span>';
        html += '<span class="task-title">' + escapeHtml(t.title) + '</span>';
        html += newBadge;
        html += '</div>';
        if (t.segment) {
          html += '<div class="task-segment">' + escapeHtml(t.segment) + '</div>';
        }
        html += '<div class="task-card-footer">';
        html += '<span class="task-assignees">' + assigneeNames + '</span>';
        html += '<span class="task-due ' + statusClass + '">' + (t.dueDate || '') + '</span>';
        html += '</div></div>';
      });
      html += '</div>';
    }
    html += '</div>';
  });

  container.innerHTML = html;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== 客户组折叠 ====================
function toggleClientGroup(clientId) {
  if (!data.collapsedClients) data.collapsedClients = [];
  var idx = data.collapsedClients.indexOf(clientId);
  if (idx === -1) {
    data.collapsedClients.push(clientId);
  } else {
    data.collapsedClients.splice(idx, 1);
  }
  saveData();
  renderKanban();
}

function expandAllClients() {
  data.collapsedClients = [];
  saveData();
  renderKanban();
}

function collapseAllClients() {
  if (!data.clients) return;
  data.collapsedClients = data.clients.map(function(c) { return c.id; });
  saveData();
  renderKanban();
}

// ==================== 任务详情弹窗 ====================
function openTaskDetail(taskId) {
  if (!data || !data.tasks) return;
  var task = data.tasks.find(function(t) { return t.id === taskId; });
  if (!task) return;
  // 标记已查看
  var uid = getCurrentUserId();
  if (uid && task.firstViewedBy) {
    task.firstViewedBy[uid] = new Date().toISOString();
  }
  saveData();
  renderKanban();
  // 简单弹窗
  alert('任务: ' + task.title + '\n进度: ' + (task.progress || '无') + '\n负责人: ' + (task.assignees || []).map(function(aid) {
    var m = data.members.find(function(m) { return m.id === aid; });
    return m ? m.name : aid;
  }).join(', ') + '\n截止日期: ' + (task.dueDate || '无'));
}

// ==================== 用户切换/登录 ====================
function switchToUser(userId) {
  setCurrentUserId(userId);
  data.currentUserId = userId;
  renderAll();
  closeUserMenu();
}

function showLoginFromMenu() {
  var members = data.members || [];
  if (members.length > 0) {
    switchToUser(members[0].id);
  }
}

function doLogout() {
  localStorage.removeItem(STORAGE_KEY);
  data.currentUserId = null;
  renderAll();
  closeUserMenu();
}

// ==================== 用户菜单弹窗 ====================
function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  var popup = document.getElementById('userMenuPopup');
  var overlay = document.getElementById('userMenuOverlay');
  var trigger = document.getElementById('userMenuTrigger');
  if (!popup) return;
  if (popup.classList.contains('show')) {
    closeUserMenu();
  } else {
    renderUserMenu();
    popup.classList.add('show');
    if (overlay) overlay.classList.add('show');
    if (trigger) trigger.classList.add('menu-open');
  }
}

function closeUserMenu() {
  var popup = document.getElementById('userMenuPopup');
  var overlay = document.getElementById('userMenuOverlay');
  var trigger = document.getElementById('userMenuTrigger');
  if (popup) popup.classList.remove('show');
  if (overlay) overlay.classList.remove('show');
  if (trigger) trigger.classList.remove('menu-open');
}

// ==================== 导入导出 ====================
function exportToExcel() {
  if (!data || !data.tasks || data.tasks.length === 0) {
    alert('没有任务可导出');
    return;
  }
  var rows = data.tasks.map(function(t) {
    return {
      '任务标题': t.title,
      '客户/项目': t.segment || '',
      '进度': t.progress || '',
      '标签': (t.tags || []).join(', '),
      '负责人': (t.assignees || []).map(function(aid) {
        var m = data.members.find(function(m) { return m.id === aid; });
        return m ? m.name : aid;
      }).join(', '),
      '截止日期': t.dueDate || '',
      '完成日期': t.completedDate || '',
      '状态': getTaskStatus(t) === 'overdue' ? '逾期' : getTaskStatus(t) === 'done' ? '已完成' : '进行中',
      '客户ID': t.clientId || '',
    };
  });
  var ws = XLSX.utils.json_to_sheet(rows);
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '任务列表');
  XLSX.writeFile(wb, '任务导出_' + new Date().toISOString().slice(0, 10) + '.xlsx');
}

function exportToPDF() {
  if (!data || !data.tasks || data.tasks.length === 0) {
    alert('没有任务可导出');
    return;
  }
  var doc = new window.jspdf.jsPDF({ orientation: 'landscape' });
  doc.setFontSize(12);
  doc.text('任务列表', 14, 15);
  var rows = data.tasks.map(function(t, i) {
    return [
      i + 1,
      t.title,
      t.segment || '',
      (t.assignees || []).map(function(aid) {
        var m = data.members.find(function(m) { return m.id === aid; });
        return m ? m.name : aid;
      }).join(', '),
      t.dueDate || '',
      getTaskStatus(t) === 'overdue' ? '逾期' : getTaskStatus(t) === 'done' ? '已完成' : '进行中',
    ];
  });
  doc.autoTable({
    head: [['#', '任务', '客户/项目', '负责人', '截止日期', '状态']],
    body: rows,
    startY: 20,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [91, 95, 199] },
  });
  doc.save('任务导出_' + new Date().toISOString().slice(0, 10) + '.pdf');
}

function importTasksExcel(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws);
      if (rows.length === 0) {
        alert('Excel 文件中没有数据');
        return;
      }
      var imported = 0;
      rows.forEach(function(row) {
        var title = row['任务标题'] || row['title'] || row['任务'] || '';
        if (!title) return;
        var assigneeNames = (row['负责人'] || row['assignee'] || row['assignees'] || '').toString().split(/[,，、]/);
        var assigneeIds = [];
        assigneeNames.forEach(function(name) {
          name = name.trim();
          var m = data.members.find(function(m) { return m.name === name; });
          if (m) assigneeIds.push(m.id);
        });
        var clientName = (row['客户ID'] || row['clientId'] || row['客户'] || '其他').toString().trim();
        var client = data.clients.find(function(c) { return c.name === clientName || c.id === clientName; });
        var task = {
          id: 't_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8),
          title: title,
          segment: (row['客户/项目'] || row['segment'] || row['项目'] || '').toString().trim(),
          progress: (row['进度'] || row['progress'] || '').toString().trim(),
          tags: (row['标签'] || row['tags'] || '').toString().split(/[,，]/).map(function(s) { return s.trim(); }).filter(Boolean),
          assignees: assigneeIds.length > 0 ? assigneeIds : ['u1'],
          clientId: client ? client.id : 'c13',
          dueDate: (row['截止日期'] || row['dueDate'] || row['due'] || '').toString().trim(),
          completedDate: (row['完成日期'] || row['completedDate'] || '').toString().trim(),
          firstViewedBy: {},
          commentReadBy: {},
          createdAt: new Date().toISOString(),
          createdBy: getCurrentUserId() || 'u3',
          comments: [],
          history: [],
        };
        data.tasks.push(task);
        imported++;
      });
      saveData();
      renderKanban();
      alert('成功导入 ' + imported + ' 条任务');
    } catch (err) {
      alert('导入失败: ' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

// ==================== 初始化 ====================
async function initApp() {
  try {
    data = await loadData();
    renderAll();
    // 启动轮询
    setInterval(pollSync, 30000);
    console.log('应用初始化完成');
  } catch (e) {
    console.error('初始化失败:', e);
  }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
  initApp();
});

// 点击空白关闭菜单
document.addEventListener('click', function(e) {
  var popup = document.getElementById('userMenuPopup');
  if (popup && popup.classList.contains('show')) {
    if (!popup.contains(e.target) && e.target.id !== 'userMenuTrigger') {
      closeUserMenu();
    }
  }
});