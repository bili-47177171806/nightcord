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

  /**
   * 创建 UI 管理器实例
   * @param {EventBus} eventBus - 事件总线实例
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.isAtBottom = true;

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

    // 只存储最后一条消息的时间戳和消息内容（不含avatar/color/time），不存系统消息
    let localMsgs = [];
    let lastMsgTimestamp = 0;
    try {
      localMsgs = JSON.parse(localStorage.getItem('nightcord-messages') || '[]');
      lastMsgTimestamp = Number(localStorage.getItem('nightcord-lastmsg') || 0);
    } catch (e) {
      localMsgs = [];
      lastMsgTimestamp = 0;
    }
    this.messages = Array.isArray(localMsgs) ? localMsgs : [];
    this.lastMsgTimestamp = lastMsgTimestamp;
    this.roster = [];

    this.systemIcon = `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13,10.69v2.72H10.23V10.69Zm3,0v2.69h2.69V10.72ZM23.29,12A11.31,11.31,0,1,1,12,.67,11.31,11.31,0,0,1,23.29,12Zm-.18.07a8.87,8.87,0,1,0-8.87,8.86A8.87,8.87,0,0,0,23.11,12.05Z" fill="white"></path></svg>`;

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
    this.eventBus.on('message:error', (data) => this.addChatMessage(null, "* Error: " + data.error));
    this.eventBus.on('message:sent', () => this.clearChatInput());
    this.eventBus.on('user:joined', (data) => this.addUserToRoster(data.username));
    this.eventBus.on('user:quit', (data) => this.removeUserFromRoster(data.username));
    this.eventBus.on('user:rename', (data) => this.handleUserRename(data.oldUsername, data.newUsername));
    this.eventBus.on('roster:clear', () => this.clearRoster());
    this.eventBus.on('room:ready', (data) => {
      // data.messages 为服务器返回的最新100条消息，格式应为 [{user, text, timestamp}, ...]
      let serverMsgs = Array.isArray(data.messages) ? data.messages : [];
      // 只保留非系统消息
      serverMsgs = serverMsgs.filter(m => m.user !== '系统');
      // 取本地消息中比服务器最早一条还早的部分
      let localMsgs = [];
      try {
        localMsgs = JSON.parse(localStorage.getItem('nightcord-messages') || '[]');
      } catch (e) { localMsgs = []; }
      if (serverMsgs.length > 0 && localMsgs.length > 0) {
        const minServerTs = Math.min(...serverMsgs.map(m => m.timestamp));
        // 只取比服务器最早一条还早的本地消息
        localMsgs = localMsgs.filter(m => m.timestamp < minServerTs && m.user !== '系统');
      }
      // 合并：本地早期消息 + 服务器消息
      this.messages = [...localMsgs, ...serverMsgs].map(m => {
        // 兼容老数据
        const {user, text, timestamp} = m;
        const {name, avatar, color} = this.generateAvatar(user);
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
      // 记录最新消息时间戳
      if (this.messages.length > 0) {
        const lastTs = this.messages[this.messages.length-1].timestamp;
        localStorage.setItem('nightcord-lastmsg', String(lastTs));
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
    this.elements.roomName.textContent = roomname;
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
      msgDiv.innerHTML = `
      <span class="avatar ${msg.color}">${msg.avatar}</span>
      <div class="message-content">
        <div class="message-header">
          <span class="message-user">${msg.user}</span>
          <span class="message-time">${msg.time}</span>
        </div>
        ${msg.text ? `<p class="message-text">${msg.text}</p>` : ''}
      </div>
    `;
      this.elements.chatlog.appendChild(msgDiv);
    });
    this.elements.chatlog.scrollTop = this.elements.chatlog.scrollHeight;
  }

  /**
   * 设置聊天室界面
   * @param {Function} onSendMessage - 发送消息时的回调函数 (message) => void
   * @param {Function} onSetUser - 设置用户名时的回调函数 (username) => void
   */
  setupChatRoom(onSendMessage, onSetUser) {
    const { chatInput, chatlog } = this.elements;

    if(onSetUser) {
      this.onSetUser = onSetUser;
    }

    // Submit message
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && chatInput.value.trim() !== "") {
        let message = chatInput.value.trim();
        if (message && onSendMessage) {
          if (pangu) {
            message = pangu.spacingText(message);
          }
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

    // Focus chat input on click
    this.elements.main.addEventListener("click", () => {
      if (window.getSelection().toString() == "") {
        chatInput.focus();
      }
    });

    chatInput.focus();
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
    // 保存到localStorage（只存user、text、timestamp）
    try {
      let localMsgs = JSON.parse(localStorage.getItem('nightcord-messages') || '[]');
      localMsgs.push(msgObj);
      if (localMsgs.length > 2000) localMsgs = localMsgs.slice(localMsgs.length - 2000);
      localStorage.setItem('nightcord-messages', JSON.stringify(localMsgs));
      localStorage.setItem('nightcord-lastmsg', String(msgObj.timestamp));
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