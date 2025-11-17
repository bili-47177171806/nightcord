/**
 * UIManager - UI 管理器
 * 负责处理所有用户界面相关的逻辑和 DOM 操作
 * 通过回调函数和事件总线与业务逻辑层通信
 * 
 * @example
 * const eventBus = new EventBus();
 * const ui = new UIManager(eventBus);
 * 
 * // 设置用户名选择器
 * ui.setupNameChooser((username) => {
 *   console.log('User chose name:', username);
 * });
 * 
 * // 添加聊天消息
 * ui.addChatMessage('K', 'As always, at 25:00.');
 */
class UIManager {
  static MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
  static TWELVE_HOURS_MS = UIManager.MILLISECONDS_PER_DAY / 2;
  static STICKER_WIDTH_THRESHOLD = 180;

  /**
   * 简单节流函数，确保处理器每 wait 毫秒最多执行一次
   * @param {Function} fn 
   * @param {number} wait 
   * @returns {Function}
   */
  static throttle(fn, wait) {
    let lastTime = 0;
    return function (...args) {
      const now = Date.now();
      if (now - lastTime >= wait) {
        lastTime = now;
        fn.apply(this, args);
      }
    };
  }

  /**
   * 创建 UI 管理器实例
   * @param {EventBus} eventBus - 事件总线实例
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.isAtBottom = true;

    // 触摸和滚动检测
    this.lastUserActivityTime = Date.now(); // 最后一次用户活动时间（触摸、滚轮、滚动等），初始化为当前时间
    this.scrollThreshold = 150; // 距离底部超过此像素数认为在阅读历史消息
    this.interactionTimeWindow = 5000; // 5秒内有用户交互活动则不自动滚动

    // DOM elements
    this.elements = {
      main: document.querySelector(".main"),
      nameInput: document.querySelector("#name-input"),
      roomNameInput: document.querySelector("#room-name"),
      roomName: document.querySelector(".channel > span"),
      goPublicButton: document.querySelector("#go-public"),
      goPrivateButton: document.querySelector("#go-private"),
      chatroom: document.querySelector("#chatroom"),
      chatlog: document.querySelector("#messages"),
      chatInput: document.querySelector("#messageInput"),
      roster: document.querySelector("#voice-users"),
    };

    this.onSetUser = null;

    // 当前房间（由外部调用 setCurrentRoom / room:ready 设置）
    this.currentRoom = null;
    // 每条消息对象只保留 user/text/timestamp 存入 localStorage；渲染层会补充 avatar/color/time
    this.messages = [];
    this.lastMsgTimestamp = 0;
    this.roster = [];

    this.systemIcon = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13,10.69v2.72H10.23V10.69Zm3,0v2.69h2.69V10.72ZM23.29,12A11.31,11.31,0,1,1,12,.67,11.31,11.31,0,0,1,23.29,12Zm-.18.07a8.87,8.87,0,1,0-8.87,8.86A8.87,8.87,0,0,0,23.11,12.05Z" fill="white"></path></svg>`;

    // Storage manager (handles per-room keys and legacy migration)
    try {
      this.storage = new StorageManager();
    } catch (e) {
      // If StorageManager is not available for some reason, provide a fallback object
      console.warn('StorageManager not available, falling back to inline storage helpers');
      this.storage = null;
    }

    this.setupEventListeners();
  }

  /**
   * 设置事件监听器，订阅业务逻辑事件
   * @private
   */
  setupEventListeners() {
    // Subscribe to chat room events
    this.eventBus.on('message:received', (data) => {
      // 只存储非系统消息
      if (data.name === '系统') return;
      // 检查本地是否已存在该消息（通过时间戳和内容简单去重）
      const exists = this.messages.some(
        m => m.text === data.message && m.user === data.name && m.timestamp === data.timestamp
      );
      if (!exists) {
        this.addChatMessage(data.name, data.message, data.timestamp);
      }
    });
    this.eventBus.on('message:error', (data) => this.showError(data.error));
    this.eventBus.on('message:sent', () => this.clearChatInput());
    this.eventBus.on('user:joined', (data) => this.addUserToRoster(data.username));
    this.eventBus.on('user:quit', (data) => this.removeUserFromRoster(data.username));
    this.eventBus.on('user:rename', (data) => this.handleUserRename(data.oldUsername, data.newUsername));
    this.eventBus.on('roster:clear', () => this.clearRoster());
    this.eventBus.on('room:ready', (data) => {
      // data.messages 为服务器返回的最新100条消息，格式应为 [{user, text, timestamp}, ...]
      const room = data.roomname || this.currentRoom || 'nightcord-default';
      this.currentRoom = room;
      let serverMsgs = Array.isArray(data.messages) ? data.messages : [];
      // 只保留非系统消息
      serverMsgs = serverMsgs.filter(m => m.user !== '系统');
      // 取本地消息中比服务器最早一条还早的部分
      let localMsgs = (this.storage ? this.storage.loadMessages(room) : this.loadLocalMessages(room)) || [];
      if (serverMsgs.length > 0 && localMsgs.length > 0) {
        const minServerTs = Math.min(...serverMsgs.map(m => m.timestamp));
        // 只取比服务器最早一条还早的本地消息
        localMsgs = localMsgs.filter(m => m.timestamp < minServerTs && m.user !== '系统');
      }
      // 合并：本地早期消息 + 服务器消息
      this.messages = [...localMsgs, ...serverMsgs].map(m => {
        // 兼容老数据
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          time: timestamp ? this.formatDate(timestamp) : '',
          text,
          timestamp
        };
      });
      // 渲染
      this.renderMessages();
      // 记录最新消息时间戳 到 per-room lastmsg
      if (this.messages.length > 0) {
        const lastTs = this.messages[this.messages.length - 1].timestamp;
        if (this.storage) this.storage.setLastMsgTimestamp(room, lastTs); else this.setLastMsgTimestamp(room, lastTs);
      }
      // 欢迎消息
      this.showWelcomeMessages(data);
    });
    this.eventBus.on('error', (data) => this.showError(data.message));
  }

  /**
   * 设置用户名选择器
   * @param {Function} callback - 用户名选择回调函数
   */
  setupNameChooser(callback) {
    // TODO: Implement name chooser setup
  }

  setCurrentRoom(roomname) {
    this.currentRoom = roomname;
    this.elements.roomName.textContent = roomname;
    // 切换到新房间时，尝试从本地存储加载消息并渲染（若随后有 room:ready 会被覆盖为合并后的消息）
    try {
      const local = (this.storage ? this.storage.loadMessages(this.currentRoom || 'nightcord-default') : this.loadLocalMessages(this.currentRoom || 'nightcord-default'));
      // transform similar to room:ready: ensure fields for rendering
      this.messages = (Array.isArray(local) ? local : []).map(m => {
        const { user, text, timestamp } = m;
        const { name, avatar, color } = this.generateAvatar(user);
        return {
          user: name,
          avatar,
          color,
          time: timestamp ? this.formatDate(timestamp) : '',
          text,
          timestamp
        };
      });
      this.lastMsgTimestamp = this.storage ? this.storage.getLastMsgTimestamp(this.currentRoom || 'nightcord-default') : this.getLastMsgTimestamp(this.currentRoom || 'nightcord-default');
      this.renderMessages();
    } catch (e) {
      // ignore
    }
  }

  // 如果 StorageManager 不可用，保留一组兼容的本地 helper（非常规情况）
  storageKeyMessages(room) { return `nightcord-messages:${room}`; }
  storageKeyLastMsg(room) { return `nightcord-lastmsg:${room}`; }
  loadLocalMessages(room) {
    try { return JSON.parse(localStorage.getItem(this.storageKeyMessages(room)) || '[]'); } catch (e) { return []; }
  }
  saveLocalMessages(room, msgs) {
    try { localStorage.setItem(this.storageKeyMessages(room), JSON.stringify(msgs)); } catch (e) {}
  }
  getLastMsgTimestamp(room) {
    try { return Number(localStorage.getItem(this.storageKeyLastMsg(room)) || 0); } catch (e) { return 0; }
  }
  setLastMsgTimestamp(room, ts) {
    try { localStorage.setItem(this.storageKeyLastMsg(room), String(ts)); } catch (e) {}
  }

  fnv1a(s) {
    if (typeof s !== 'string') throw new TypeError('Expected string');
    let h = 2166136261 >>> 0;
    s = 'nightcord:' + s;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h & 7;
  }

  generateAvatar(username) {
    const colors = ['bg-pink-500', 'bg-purple-400', 'bg-teal-400', 'bg-pink-400', 'bg-purple-600', 'bg-green-600', 'bg-red-600', 'bg-default'];
    const bucket = this.fnv1a(username);
    return {
      name: username,
      avatar: username[0].toUpperCase(),
      color: colors[bucket]
    };
  }

  /**
   * Sticker 相关配置与渲染
   */
  stickerDir = 'https://houtar-disk.oss-cn-shanghai.aliyuncs.com/nightcord/stickers';

  /**
   * 将文本进行 HTML 转义，防止 XSS。
   * @param {string} s
   * @returns {string}
   */
  escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 将消息文本中的 [name] 替换为 sticker 图片（如果存在）。
   * 保持其余文本做 HTML 转义并保留换行。
   * @param {string} text
   * @returns {string} 安全的 html 片段
   */
  renderTextWithStickers(text) {
    // 返回 DocumentFragment，包含文本节点、<br> 和 <img> 节点（带事件监听器）
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    // 只有消息完全等于一个 sticker（前后可有空白）时才视为 fixed
    const isSingleSticker = /^\s*\[[^\]]+\]\s*$/.test(text);
    const re = /\[([^\]]+)\]/g; // 匹配 [内容]
    let lastIndex = 0;

    const appendTextWithLineBreaks = (str) => {
      if (!str) return;
      const parts = str.split('\n');
      parts.forEach((p, i) => {
        if (p.length > 0) frag.appendChild(document.createTextNode(p));
        if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
      });
    };

    let m;
    while ((m = re.exec(text)) !== null) {
      const idx = m.index;
      const matched = m[0];
      const name = m[1];
      // 添加前面的普通文本（作为文本节点，避免 XSS）
      if (idx > lastIndex) {
        appendTextWithLineBreaks(text.slice(lastIndex, idx));
      }

      const key = String(name).toLowerCase();
      const fileName = key.includes('_') ? key.replace('_', '/') : key;
      const src = `${this.stickerDir}/${encodeURIComponent(fileName)}.png`;

      const img = document.createElement('img');
      img.classList.add('sticker', 'sticker-loading');
      if (isSingleSticker) img.classList.add('sticker-fixed'); else img.classList.add('sticker-inline');
      img.src = src;
      img.alt = `[${name}]`;
      img.title = name;
      img.loading = 'lazy';

      // 加载完成：移除占位；若渲染后宽度超过阈值则切换到 narrow
      const onLoad = () => {
        img.classList.remove('sticker-loading');
        try {
          if (img.width > UIManager.STICKER_WIDTH_THRESHOLD) {
            img.classList.remove('sticker-fixed');
            img.classList.add('sticker-narrow');
          }
        } catch (e) {}
        img.removeEventListener('load', onLoad);
      };
      img.addEventListener('load', onLoad, { once: true });

      const onError = () => {
        // 替换为原始文本（例如 [name]），避免显示浏览器的 broken image 图标
        const replacement = document.createElement('span');
        replacement.className = 'sticker-broken';
        replacement.textContent = img.alt || '';
        try { img.replaceWith(replacement); } catch (e) {
          // fallback: hide the image
          img.style.display = 'none';
        }
        // 清理事件与 src
        try { img.src = ''; } catch (e) {}
        img.removeEventListener('error', onError);
      };
      img.addEventListener('error', onError, { once: true });

      frag.appendChild(img);
      lastIndex = idx + matched.length;
    }

    // 剩余文本
    if (lastIndex < text.length) {
      appendTextWithLineBreaks(text.slice(lastIndex));
    }

    return frag;
  }

  /**
   * 渲染语音用户列表
   */
  renderVoiceUsers() {
    this.elements.roster.innerHTML = '';
    // 获取当前用户名
    let currentName = null;
    try {
      currentName = localStorage.getItem('nightcord-username');
    } catch (e) {}
    this.roster.forEach(user => {
      const div = document.createElement('div');
      div.className = 'voice-user';
      div.innerHTML = `
          <div class="voice-user-info">
            <span class="avatar ${user.color}">${user.avatar}</span>
            <span style="font-size:14px;">${user.name}</span>
          </div>
        `;
      // 只有是自己才可点击
      if (user.name === currentName) {
        div.style.cursor = 'pointer';
        div.title = '点击修改你的昵称';
        div.addEventListener('click', () => {
          const newName = window.prompt('请输入新的昵称', user.name);
          if (newName && newName !== user.name) {
            localStorage.setItem('nightcord-username', newName);
            // 通知业务逻辑层
            if (this.onSetUser) {
              this.onSetUser(newName);
            }
          }
        });
      }
      this.elements.roster.appendChild(div);
    });
  }

  /**
   * 渲染消息列表
   */
  renderMessages() {
    this.elements.chatlog.innerHTML = '';
    this.messages.forEach(msg => {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message';

      // Avatar
      const avatarSpan = document.createElement('span');
      avatarSpan.className = `avatar ${msg.color}`;
      avatarSpan.innerHTML = msg.avatar;

      // Content
      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';

      // Header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'message-header';
      const userSpan = document.createElement('span');
      userSpan.className = 'message-user';
      userSpan.textContent = msg.user;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'message-time';
      timeSpan.textContent = msg.time;
      headerDiv.appendChild(userSpan);
      headerDiv.appendChild(timeSpan);
      contentDiv.appendChild(headerDiv);

      // Message text (may contain stickers) — renderTextWithStickers 返回 DocumentFragment
      if (msg.text) {
        const p = document.createElement('p');
        p.className = 'message-text';
        const frag = this.renderTextWithStickers(msg.text);
        p.appendChild(frag);
        contentDiv.appendChild(p);
      }

      msgDiv.appendChild(avatarSpan);
      msgDiv.appendChild(contentDiv);
      this.elements.chatlog.appendChild(msgDiv);
    });

    // 智能滚动逻辑
    // 检查是否应该自动滚动到底部
    const shouldAutoScroll = this.shouldAutoScrollToBottom();
    if (shouldAutoScroll) {
      this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
    }
  }

  /**
   * 判断是否应该自动滚动到底部
   * 条件：
   * 1. 用户当前在底部附近 (距离底部 < scrollThreshold 像素)
   * 2. 或者用户最近没有触摸/滚动操作（超过指定时间窗口）
   * @returns {boolean}
   */
  shouldAutoScrollToBottom() {
    const timeSinceLastTouch = Date.now() - this.lastUserActivityTime;
    // 如果用户在底部附近，或者已经很久没有交互，就自动滚动
    return this.isAtBottom || timeSinceLastTouch > this.interactionTimeWindow;
  }

  /**
   * 设置聊天室界面
   * @param {Function} onSendMessage - 发送消息时的回调函数 (message) => void
   * @param {Function} onSetUser - 设置用户名时的回调函数 (username) => void
   */
  setupChatRoom(onSendMessage, onSetUser) {
    const { chatInput, chatlog } = this.elements;

    if (onSetUser) {
      this.onSetUser = onSetUser;
    }

    // 监听滚动事件，检测用户是否接近底部
    chatlog.addEventListener("scroll", UIManager.throttle(() => {
      const distanceFromBottom = chatlog.scrollHeight - chatlog.scrollTop - chatlog.clientHeight;
      // 如果距离底部小于阈值，认为用户在底部附近
      this.isAtBottom = distanceFromBottom < this.scrollThreshold;
      this.updateUserActivityTime();
    }, 100).bind(this));

    // 监听触摸事件（移动端）
    chatlog.addEventListener("touchmove", UIManager.throttle(() => {
      this.updateUserActivityTime();
    }, 100).bind(this));

    // 监听鼠标滚轮事件（桌面端）
    chatlog.addEventListener("wheel", UIManager.throttle(() => {
      this.updateUserActivityTime();
    }, 100).bind(this));

    // Submit message
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && chatInput.value.trim() !== "") {
        let message = chatInput.value.trim();
        if (message && onSendMessage) {
          if (pangu) {
            message = pangu.spacingText(message);
          }
          // Normalize stamp emoji format: replace [stamp_0806] with [stamp0806] to unify sticker rendering
          // 规范化 stamp 表情格式：将 [stamp_0806] 替换为 [stamp0806]，以统一处理 sticker 渲染
          message = message.replace(/\[stamp_(\d+)\]/g, (_, p1) => `[stamp${p1}]`);
          // 用户主动发送消息，重置交互时间并标记在底部
          // 发送消息后标记在底部，确保下次渲染会自动滚动
          this.isAtBottom = true;
          this.updateUserActivityTime();
          onSendMessage(message);
        }
      }
    });

    // Limit message length
    chatInput.addEventListener("input", (event) => {
      if (event.currentTarget.value.length > 256) {
        event.currentTarget.value = event.currentTarget.value.slice(0, 256);
      }
    });

    /**
     * Handles bracket insertion with auto-pairing for both keyboard and emoji button inputs.
     * - If there is a selection, wraps the selected text with [ and ] and places the caret after the closing bracket.
     * - If the next character is ']', skips over it instead of inserting a duplicate.
     * - Otherwise, inserts paired [] and places the caret between them.
     *
     * @param {HTMLInputElement|HTMLTextAreaElement} input - The input element to modify.
     */
    const handleLeftBracket = (input) => {
      const val = input.value || '';
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;

      if (start !== end) {
        // wrap selection with [ ... ] and place caret after the closing bracket
        const newVal = val.slice(0, start) + '[' + val.slice(start, end) + ']' + val.slice(end);
        input.value = newVal;
        const caretPos = end + 2; // after the closing ]
        input.setSelectionRange(caretPos, caretPos);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        return;
      }

      // if next char is ']', skip over it
      if (val.charAt(start) === ']') {
        input.setSelectionRange(start + 1, start + 1);
        input.focus();
        return;
      }

      // insert paired [] and put caret between
      const newVal = val.slice(0, start) + '[]' + val.slice(end);
      input.value = newVal;
      const caretPos = start + 1;
      input.setSelectionRange(caretPos, caretPos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    };

    // Bracket auto-pairing and overwrite behavior for keyboard input
    chatInput.addEventListener('keydown', (event) => {
      try {
        const val = chatInput.value || '';
        const start = chatInput.selectionStart ?? 0;
        const end = chatInput.selectionEnd ?? start;

        // '[': use shared handler
        if (event.key === '[') {
          event.preventDefault();
          handleLeftBracket(chatInput);
          return;
        }

        // ']': if next is ']', skip over instead of inserting duplicate
        if (event.key === ']') {
          if (start === end && val.charAt(start) === ']') {
            event.preventDefault();
            chatInput.setSelectionRange(start + 1, start + 1);
            return;
          }
          // otherwise allow default insertion
        }

        // Backspace: if caret is between an empty pair [] then delete both
        if (event.key === 'Backspace') {
          if (start === end && start > 0 && val.charAt(start - 1) === '[' && val.charAt(start) === ']') {
            event.preventDefault();
            const newVal = val.slice(0, start - 1) + val.slice(start + 1);
            const caretPos = start - 1;
            chatInput.value = newVal;
            chatInput.setSelectionRange(caretPos, caretPos);
            chatInput.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
        }
      } catch (e) {
        // don't block typing on unexpected errors
        console.warn('Error in keydown handler (bracket auto-pairing and backspace) for key:', event.key, {
          value: chatInput.value,
          selectionStart: chatInput.selectionStart,
          selectionEnd: chatInput.selectionEnd
        }, e);
      }
    });

    // Focus chat input on click
    this.elements.main.addEventListener("click", () => {
      if (window.getSelection().toString() == "") {
        chatInput.focus();
      }
    });

    chatInput.focus();

    // 表情按钮：使用与按键 '[' 相同的自动配对逻辑
    try {
      const emojiBtn = document.querySelector('.input-btns button[title="表情"]');
      if (emojiBtn) {
        emojiBtn.addEventListener('click', (e) => {
          e.preventDefault();
          const input = this.elements.chatInput;
          if (!input) return;
          handleLeftBracket(input);
        });
      }
    } catch (e) {
      const emojiBtn = document.querySelector('.input-btns button[title="表情"]');
      if (!emojiBtn) {
        console.warn('绑定表情按钮失败: 未找到表情按钮元素', e);
      } else {
        console.warn('绑定表情按钮失败: 事件监听器绑定异常', e, e && e.stack);
      }
    }
  }

  /**
   * 更新用户活动时间
   */
  updateUserActivityTime() {
    this.lastUserActivityTime = Date.now();
  }

  /**
   * 添加聊天消息到聊天日志
   * @param {string} name - 发送者名称
   * @param {string} message - 消息内容
   * @param {string} [avatar] - 发送者头像
   * @param {string} [color='bg-default'] - 头像背景颜色
   */
  addChatMessage(user, message, timestamp, avatar, color) {
    // 系统消息不存本地
    if (user === '系统') {
      const { name, avatar: userAvatar, color: userColor } = this.generateAvatar(user);
      this.messages.push({
        user: name,
        avatar: avatar ?? userAvatar,
        color: color ?? userColor,
        time: timestamp ? this.formatDate(timestamp) : new Date().toLocaleTimeString(),
        text: message,
        timestamp: timestamp || Date.now()
      });
      this.renderMessages();
      return;
    }
    const { name, avatar: userAvatar, color: userColor } = this.generateAvatar(user);
    const msgObj = {
      user: name,
      text: message,
      timestamp: timestamp || Date.now()
    };
    this.messages.push({
      user: name,
      avatar: avatar ?? userAvatar,
      color: color ?? userColor,
      time: timestamp ? this.formatDate(timestamp) : new Date().toLocaleTimeString(),
      text: message,
      timestamp: msgObj.timestamp
    });
    // 保存到 localStorage（按房间存储，只存 user/text/timestamp）
    try {
      const room = this.currentRoom || 'nightcord-default';
      let localMsgs = this.storage ? this.storage.loadMessages(room) : (this.loadLocalMessages(room) || []);
      localMsgs.push(msgObj);
      if (localMsgs.length > 2000) localMsgs = localMsgs.slice(localMsgs.length - 2000);
      if (this.storage) this.storage.saveMessages(room, localMsgs); else this.saveLocalMessages(room, localMsgs);
      if (this.storage) this.storage.setLastMsgTimestamp(room, msgObj.timestamp); else this.setLastMsgTimestamp(room, msgObj.timestamp);
    } catch (e) {}
    this.lastMsgTimestamp = msgObj.timestamp;
    this.renderMessages();
  }
  /**
   * 清空聊天输入框
   */
  clearChatInput() {
    this.elements.chatInput.value = "";
  }

  /**
   * 添加用户到在线用户列表
   * @param {string} username - 用户名
   */
  addUserToRoster(username) {
    // Avoid adding duplicate entries for the same username. Server may emit
    // a user:joined after we have locally renamed the user, so skip if
    // username already exists in the roster.
    if (this.roster.some(u => u.name === username)) return;
    this.roster.push(this.generateAvatar(username));
    this.renderVoiceUsers();
  }

  /**
   * 平滑处理用户名变更：只替换指定用户的显示，而不清空整个列表
   * @param {string} oldUsername
   * @param {string} newUsername
   */
  handleUserRename(oldUsername, newUsername) {
    if (!oldUsername || !newUsername) return;
    const idx = this.roster.findIndex(u => u.name === oldUsername);
    if (idx !== -1) {
      this.roster[idx] = this.generateAvatar(newUsername);
      this.renderVoiceUsers();
    } else {
      // If not present, just add the new username
      this.addUserToRoster(newUsername);
    }
  }

  /**
   * 从在线用户列表移除用户
   * @param {string} username - 用户名
   */
  removeUserFromRoster(username) {
    // Remove all matching users with the provided username to guard against
    // duplicates and then re-render only if something changed.
    const newRoster = this.roster.filter(user => user.name !== username);
    if (newRoster.length !== this.roster.length) {
      this.roster = newRoster;
      this.renderVoiceUsers();
    }
  }

  /**
   * 清空在线用户列表
   */
  clearRoster() {
    this.roster = [];
    this.renderVoiceUsers();
  }

  /**
   * 显示欢迎消息
   * @param {Object} data - 欢迎消息数据
   */
  showWelcomeMessages(data) {
    this.addChatMessage('系统', `警告: 此聊天室的参与者是互联网上的随机用户。用户名未经认证，任何人都可以冒充任何人。聊天记录将被保存。`, null, this.systemIcon, 'bg-red-600');
    this.addChatMessage('系统', '提示: 若要修改你的昵称，点击左侧在线用户列表中你的昵称并输入新昵称。', null, this.systemIcon, 'bg-default');
    this.addChatMessage('系统', `欢迎来到聊天室: ${data.roomname}`, null, this.systemIcon, 'bg-default');
  }

  /**
   * 显示错误消息
   * @param {string} message - 错误消息内容
   */
  showError(message) {
    this.addChatMessage('系统', `错误: ${message}`, null, this.systemIcon, 'bg-red-600');
  }

  /**
   * 获取所有 DOM 元素引用
   * @returns {Object} DOM 元素对象
   */
  getElements() {
    return this.elements;
  }

  /**
   * Format a timestamp into a human-readable string with special handling for a "30-hour" night-shift display.
   *
   * Behavior summary:
   * - If `timestamp` is falsy, returns an empty string.
   * - Final returned formats:
   *   - Same day (diffDays === 0): "HH:MM:SS" (plus the 30-hour parenthetical if applicable)
   *   - Yesterday (diffDays === 1): "昨天 HH:MM:SS"
   *   - Within the last week but not yesterday (1 < diffDays < 7): "周X HH:MM:SS" where 周X is one of ["周日","周一",...,"周六"]
   *   - Older than a week (diffDays >= 7): "M月D日 HH:MM:SS"
   *
   * Notes:
   * - This function depends on UIManager.MILLISECONDS_PER_DAY to calculate full-day differences and UIManager.TWELVE_HOURS_MS (12 hours) to compute the 30-hour adjustment.
   * - The "30-hour" clock is a display convention: times from 00:00 to 05:59 are treated as belonging to the previous night's extended shift.
   *
   * @param {number|string|Date|null|undefined} timestamp - Value accepted by `new Date(timestamp)`. If falsy, the function returns an empty string.
   * @returns {string} A formatted, localized time string with contextual day label and optional 30-hour parenthetical.
   *
   * @example
   * // Same day
   * formatDate(Date.now()) // => "14:23:05"
   *
   * @example
   * // Early morning treated as previous night (30-hour clock shown in parentheses)
   * formatDate(new Date("2025-11-13T01:05:00").getTime()) // => "01:05:00（昨天 25:05:00）"
   *
   * @example
   * // Yesterday
   * formatDate(* timestamp from yesterday *) // => "昨天 23:15:10"
   *
   * @example
   * // Within last week
   * formatDate(* timestamp from last Wednesday *) // => "周三 09:00:00"
   *
   * @example
   * // Older than a week
   * formatDate(* timestamp from months ago *) // => "11月5日 07:30:00"
   */
  formatDate(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    let timeString = date.toLocaleTimeString();

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((startToday - startDate) / UIManager.MILLISECONDS_PER_DAY);

    let adjustedTimeString = '';

    // For messages sent before 6 AM, display them as belonging to the previous night.
    // According to 30-hour clock system.
    if (date.getHours() < 6) {
      const adjustedDate = new Date(date.getTime() - UIManager.TWELVE_HOURS_MS);
      adjustedTimeString = this.formatDate(adjustedDate.getTime()).replace(/(\d{1,2}):(\d{2}):(\d{2})/, (match, p1, p2, p3) => {
        return `${parseInt(p1) + 12}:${p2}:${p3}`;
      });
      adjustedTimeString = `（${adjustedTimeString}）`;
    }

    timeString += adjustedTimeString;

    if (diffDays === 0) return timeString;
    if (diffDays === 1) return `昨天 ${timeString}`;
    if (diffDays > 1 && diffDays < 7) {
      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `${weekdays[date.getDay()]} ${timeString}`;
    }
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeString}`;
  }
}