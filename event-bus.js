/**
 * EventBus - 事件总线
 * 
 * @example
 * const eventBus = new EventBus();
 * 
 * // 订阅事件
 * eventBus.on('message', (data) => {
 *   console.log('Received:', data);
 * });
 * 
 * // 发布事件
 * eventBus.emit('message', { text: 'Hello' });
 * 
 * // 取消订阅
 * eventBus.off('message', callback);
 */
class EventBus {
  constructor() {
    /**
     * 存储事件监听器的对象
     * @type {Object.<string, Function[]>}
     */
    this.listeners = {};
  }

  /**
   * 订阅事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * 取消订阅事件
   * @param {string} event - 事件名称
   * @param {Function} callback - 要移除的回调函数
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }

  /**
   * 发布事件
   * @param {string} event - 事件名称
   * @param {*} data - 传递给监听器的数据
   */
  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach(callback => callback(data));
  }

  /**
   * 清空所有事件监听器
   */
  clear() {
    this.listeners = {};
  }

  /**
   * 清空指定事件的所有监听器
   * @param {string} event - 事件名称
   */
  clearEvent(event) {
    if (this.listeners[event]) {
      delete this.listeners[event];
    }
  }

  /**
   * 获取指定事件的监听器数量
   * @param {string} event - 事件名称
   * @returns {number} 监听器数量
   */
  listenerCount(event) {
    return this.listeners[event] ? this.listeners[event].length : 0;
  }
}
