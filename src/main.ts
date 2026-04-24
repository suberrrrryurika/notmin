import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from "@tauri-apps/api/window";
import Database from "@tauri-apps/plugin-sql";
import './style.css'
import { setupCounter } from './components/counter'

const appWindow = getCurrentWindow();

// --- 1. 基础 UI 初始化 ---
const counterBtn = document.querySelector<HTMLButtonElement>('#counter')
if (counterBtn) {
    setupCounter(counterBtn)
}

// 窗口控制
document.getElementById('titlebar-minimize')?.addEventListener('click', () => appWindow.minimize());
document.getElementById('titlebar-maximize')?.addEventListener('click', () => appWindow.toggleMaximize());
document.getElementById('titlebar-close')?.addEventListener('click', () => appWindow.close());

// 禁用右键菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

// --- 2. 数据库与业务逻辑 ---

/**
 * 渲染笔记列表
 * @param db 数据库实例
 */
// 时间格式化函数，去掉微秒部分
function formatDateWithoutMilliseconds(dateStr: string): string {
    const date = new Date(dateStr);
    // 格式化为 "yyyy-MM-dd HH:mm:ss" 形式，避免微秒部分
    return date.toISOString().split('.')[0].replace('T', ' '); // 去掉微秒部分并替换'T'为一个空格
}
// 时间格式化函数，去掉秒和微秒部分
function formatDateWithoutSeconds(dateStr: string): string {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');  // 月份从0开始，所以需要+1
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');

    // 格式化为 "yyyy-MM-dd HH:mm"
    return `${year}-${month}-${day} ${hours}:${minutes}`;
}
function setupSidebar() {
    const trigger = document.getElementById('sidebarToggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');

    if (trigger && sidebar) {
        trigger.addEventListener('click', () => {
            const isCollapsed = sidebar.classList.toggle('collapsed');
            // when not collapsed (open), activate overlay
            if (!isCollapsed) {
                overlay?.classList.add('active');
                // ensure the main input inside sidebar receives focus when opened
                setTimeout(() => {
                    const ta = sidebar.querySelector<HTMLTextAreaElement>('#note-input');
                    ta?.focus();
                }, 120);
            } else {
                overlay?.classList.remove('active');
            }
            console.log("侧边栏状态切换", isCollapsed ? 'closed' : 'open');
        });
    }
    // click overlay to close
    overlay?.addEventListener('click', () => {
        sidebar?.classList.add('collapsed');
        overlay?.classList.remove('active');
    });

    // keep overlay non-focusable when inactive to avoid stealing focus
    if (overlay) {
        overlay.tabIndex = -1;
    }
}
/**
 * 初始化自启 UI 绑定
 */
async function initAutostartUI() {
    const checkbox = document.getElementById('autostart-checkbox') as HTMLInputElement;
    if (!checkbox) return;

    // 1. 获取后端当前真实的自启状态并更新 UI
    const isAuto = await checkAutostartStatus();
    checkbox.checked = isAuto;

    // 2. 绑定点击事件
    checkbox.addEventListener('change', async (e) => {
        const target = e.target as HTMLInputElement;
        // 禁用 checkbox 防止在处理过程中被多次点击
        target.disabled = true;
        
        await toggleAutostart(target.checked);
        
        // 模拟一个简单的视觉反馈
        const statusLabel = document.getElementById('note-status');
        if (statusLabel) {
            statusLabel.innerText = target.checked ? "自启已激活" : "自启已禁用";
            setTimeout(() => statusLabel.innerText = "", 2000);
        }

        target.disabled = false;
    });
}
/**
 * 渲染笔记列表
 * @param db 数据库实例
 */

/**
 * 设置应用核心存储逻辑
 */
async function setupApp() {
    try {
        console.log("正在加载插件...");
        // 1. 加载数据库
        const db = await Database.load("sqlite:tasks.db");

        // 2. 确保表存在
        await db.execute(`
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT,
                remind_at TEXT,
                frequency TEXT DEFAULT 'once'
            )
        `);

        // 3. 渲染笔记列表（首次加载时允许发送补偿通知）
        await renderNotes(db, true);
        let hasLoadedOnce = true;  // 标记已完成首次加载，后续调用不再发送补偿通知
        setupSidebar();

        await initAutostartUI();

        // 为所有尚未过期的任务设置 setTimeout 精准通知
        // （弥补 processExpiredNotes 每 10 秒轮询的延迟）
        try {
            const pendingNotes = await db.select("SELECT * FROM notes") as any[];
            const now = Date.now();
            for (const note of pendingNotes) {
                if (!note.remind_at) continue;
                const remindTime = new Date(note.remind_at).getTime();
                const delayMs = remindTime - now;
                if (delayMs > 0) {
                    const noteId = note.id;
                    setTimeout(async () => {
                        // 重新从数据库读取最新数据（可能已被其他逻辑更新）
                        const db = await Database.load("sqlite:tasks.db");
                        const latest = await db.select("SELECT * FROM notes WHERE id = ?", [noteId]) as any[];
                        if (latest.length > 0) {
                            await triggerNoteReminder(db, latest[0]);
                        }
                    }, delayMs);
                    console.log(`已为任务 ID:${noteId} 设置定时通知，${Math.round(delayMs / 1000)}秒后触发`);
                }
            }
        } catch (err) {
            console.warn('设置精准定时通知失败:', err);
        }
        // 4. 绑定保存按钮事件
        const saveBtn = document.getElementById('saveNoteBtn');
        saveBtn?.addEventListener('click', async () => {
            const contentInput = document.getElementById('note-input') as HTMLTextAreaElement;
            const timeInput = document.getElementById('remind-time') as HTMLInputElement;
            const statusLabel = document.getElementById('note-status');

            const content = contentInput.value;
            const remindTime = timeInput.value;

            if (!content) {
                alert("请键入任务");
                return;
            }

            // 获取频率
            const freqInput = document.getElementById('remind-freq') as HTMLSelectElement;
            const frequency = freqInput.value;

            // 存储到数据库
            await db.execute(
                "INSERT INTO notes (content, remind_at, frequency) VALUES (?, ?, ?)",
                [content, remindTime, frequency]
            );

            console.log("数据已存入 SQLite");

            // 清空输入框并刷新列表
            contentInput.value = '';
            await renderNotes(db, false);

            // 更新状态显示
            if (statusLabel) {
                statusLabel.innerText = "保存成功！";
                setTimeout(() => statusLabel.innerText = "", 2000);
            }

            // 如果设置了提醒时间，计算并设置定时器
            if (remindTime) {
                const remindDate = new Date(remindTime);
                const delayMs = remindDate.getTime() - Date.now();

                if (delayMs > 0) {
                    // 先查询刚插入的任务 ID
                    const inserted = await db.select("SELECT last_insert_rowid() as id") as any[];
                    const newNoteId = inserted[0]?.id;
                    if (newNoteId) {
                        setTimeout(async () => {
                            const freshDb = await Database.load("sqlite:tasks.db");
                            const latest = await freshDb.select("SELECT * FROM notes WHERE id = ?", [newNoteId]) as any[];
                            if (latest.length > 0) {
                                await triggerNoteReminder(freshDb, latest[0]);
                            }
                        }, delayMs);
                    }
                }
            }
        });

        // 5. 绑定测试通知按钮
        const notifyBtn = document.getElementById('notifyBtn');
        notifyBtn?.addEventListener('click', async () => {
            await invoke('send_task_notification', {
                title: '测试通知',
                message: '如果你看到这个，说明通知功能正常！'
            });
        });

        // 6. 绑定刷新列表按钮
        const refreshBtn = document.getElementById('refreshBtn');
        refreshBtn?.addEventListener('click', async () => {
            await renderNotes(db, false);
            const statusLabel = document.getElementById('note-status');
            if (statusLabel) {
                statusLabel.innerText = "列表已刷新";
                setTimeout(() => statusLabel.innerText = "", 2000);
            }
        });

        // 定时器：静默处理过期任务，不重新渲染整个列表（避免闪烁）
        setInterval(async () => {
            const db = await Database.load("sqlite:tasks.db");
            await processExpiredNotes(db);  // 只处理过期任务，不重新渲染
        }, 10000);

    } catch (err) {
        console.error("致命错误: 插件未找到或权限被拒绝", err);
        const container = document.getElementById('notes-container');
        if (container) container.innerText = "数据库加载失败，请检查配置。";
    }
}
// 渲染笔记列表
// allowNotification: 是否允许发送补偿通知（仅首次加载时为 true）
async function renderNotes(db: Database, allowNotification: boolean = false) {
    const container = document.getElementById('notes-container');
    if (!container) return;

    try {
        // 从数据库读取所有笔记，按提醒时间排序（最接近/最早的在前）。
        // remind_at 可能为 NULL 或空字符串，我们把没有提醒时间的条目放在后面。
        // 使用 replace 将可能的 'T' 分隔符转为空格以兼容 SQLite 的 datetime() 解析。
        const notes = await db.select(
            "SELECT * FROM notes ORDER BY CASE WHEN remind_at IS NULL OR remind_at = '' THEN 1 ELSE 0 END, datetime(replace(remind_at,'T',' ')) ASC, id DESC"
        ) as any[];

        // 重置容器内容
        container.innerHTML = '';

        if (notes.length === 0) {
            container.innerHTML = '<p class="empty-msg">暂无保存的笔记</p>';
            return;
        }

        const frequencyMap: Record<string, string> = {
            'once': '一次性目标 [SINGLE]',
            'daily': '每日例行 [DAILY]',
            'weekly': '每周例行 [WEEKLY]'
        };

        // 获取当前时间
        const currentTime = new Date().getTime();

        for (const note of notes) {
            const noteElement = document.createElement('div');
            noteElement.className = 'note-item';

            // 过期任务：统一触发提醒（通知+时间更新/删除），然后跳过渲染
            const remindTime = new Date(note.remind_at).getTime();
            if (remindTime < currentTime) {
                if (allowNotification) {
                    await triggerNoteReminder(db, note);
                } else {
                    // 非首次加载时静默处理（不发送通知，只更新时间/删除）
                    if (note.frequency === 'once') {
                        await db.execute("DELETE FROM notes WHERE id = ?", [note.id]);
                    } else if (note.frequency === 'daily') {
                        const nextReminder = calculateNextReminder(remindTime, 24 * 60 * 60 * 1000);
                        await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
                    } else if (note.frequency === 'weekly') {
                        const nextReminder = calculateNextReminder(remindTime, 7 * 24 * 60 * 60 * 1000);
                        await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
                    }
                }
                continue; // 过期任务不渲染到界面
            }

            // 频率值映射
            const freqValue = note.frequency || 'once';
            const freqLabel = frequencyMap[freqValue] || '未知指令';

            noteElement.setAttribute('data-freq', freqValue);

            noteElement.innerHTML = `
    <div class="note-header">
        <span class="quest-status ${freqValue}">[ ${freqLabel} ]</span>
        <span class="note-content">${note.content}</span>
        <button class="edit-btn" data-id="${note.id}">编辑</button>
        <button class="delete-btn" data-id="${note.id}">删除</button>
    </div>
    <div class="note-meta">
        <span class="meta-label">NEXT_SYNC:</span>
        <span class="meta-value">${note.remind_at ? formatDateWithoutSeconds(note.remind_at) : 'STANDBY'}</span>
    </div>
`;

            // 删除按钮点击事件
            const deleteBtn = noteElement.querySelector('.delete-btn');
            deleteBtn?.addEventListener('click', async () => {
                const taskId = (deleteBtn as HTMLButtonElement).getAttribute('data-id');
                if (taskId) {
                    await db.execute("DELETE FROM notes WHERE id = ?", [taskId]);
                    console.log(`任务已删除，ID: ${taskId}`);
                    await renderNotes(db, false);
                }
            });

            // 编辑按钮点击事件
            const editBtn = noteElement.querySelector('.edit-btn');
            editBtn?.addEventListener('click', async () => {
                const contentSpan = noteElement.querySelector('.note-content') as HTMLSpanElement;
                if (!contentSpan) return;

                const originalContent = contentSpan.innerText;
                const textarea = document.createElement('textarea');
                textarea.className = 'edit-textarea';
                textarea.value = originalContent;
                textarea.style.width = '100%';
                textarea.style.boxSizing = 'border-box';

                const metaRow = document.createElement('div');
                metaRow.className = 'edit-meta-row';
                const timeInput = document.createElement('input');
                timeInput.type = 'datetime-local';
                timeInput.value = note.remind_at ? note.remind_at.replace(' ', 'T') : '';
                const freqSelect = document.createElement('select');
                freqSelect.innerHTML = `
                    <option value="once">单次执行 [SINGLE]</option>
                    <option value="daily">每日循环 [DAILY]</option>
                    <option value="weekly">每周例行 [WEEKLY]</option>
                `;
                freqSelect.value = note.frequency || 'once';
                metaRow.appendChild(timeInput);
                metaRow.appendChild(freqSelect);

                contentSpan.replaceWith(textarea);
                const header = noteElement.querySelector('.note-header');
                header?.insertAdjacentElement('afterend', metaRow);

                (editBtn as HTMLElement).style.display = 'none';
                (deleteBtn as HTMLElement).style.display = 'none';

                const saveBtn = document.createElement('button');
                saveBtn.className = 'save-edit-btn';
                saveBtn.innerText = '保存';
                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'cancel-edit-btn';
                cancelBtn.innerText = '取消';

                header?.appendChild(saveBtn);
                header?.appendChild(cancelBtn);

                saveBtn.addEventListener('click', async () => {
                    const newContent = textarea.value.trim();
                    const newRemindAt = timeInput.value ? timeInput.value.replace('T', ' ') : null;
                    const newFreq = freqSelect.value;

                    if (!newContent) {
                        alert('任务内容不能为空');
                        return;
                    }

                    try {
                        await db.execute("UPDATE notes SET content = ?, remind_at = ?, frequency = ? WHERE id = ?", [newContent, newRemindAt, newFreq, note.id]);
                        console.log(`任务已更新，ID: ${note.id}`);
                    } catch (err) {
                        console.error('更新任务失败:', err);
                        alert('保存失败，请重试');
                        return;
                    }

                    await renderNotes(db, false);
                });

                cancelBtn.addEventListener('click', () => {
                    const restoredSpan = document.createElement('span');
                    restoredSpan.className = 'note-content';
                    restoredSpan.innerText = originalContent;
                    textarea.replaceWith(restoredSpan);
                    metaRow.remove();

                    (editBtn as HTMLElement).style.display = '';
                    (deleteBtn as HTMLElement).style.display = '';
                    saveBtn.remove();
                    cancelBtn.remove();
                });
            });

            container.appendChild(noteElement);
        }

    } catch (err) {
        console.error("加载列表失败:", err);
        container.innerHTML = '<div class="error-msg">数据同步中断，请稍后重试。</div>';
    }
}

// 记录已触发提醒的任务 ID 和触发时间，确保每个任务在当前周期只触发一次
// key: note.id, value: 触发时的 remind_at 时间戳
const notifiedMap = new Map<number, number>();

/**
 * 触发任务提醒：发送通知并立即处理时间更新/删除
 * 这是唯一执行「发通知 + 更新时间」的函数，确保原子性
 */
async function triggerNoteReminder(db: Database, note: any): Promise<boolean> {
    // 用 note.id + remind_at 时间戳双重判断：
    // 同一个 remind_at 只触发一次；如果 remind_at 已更新为新的未来时间，则允许再次触发
    const remindTime = new Date(note.remind_at).getTime();
    const lastNotifiedAt = notifiedMap.get(note.id);
    if (lastNotifiedAt === remindTime) return false;

    // 标记当前 remind_at 已触发
    notifiedMap.set(note.id, remindTime);

    try {
        // 1. 发送通知
        await invoke('send_task_notification', {
            title: '任务提醒',
            message: note.content
        });
        console.log(`通知已发送，ID: ${note.id}`);
    } catch (err) {
        console.warn('发送通知失败:', err);
    }

    // 2. 立即处理时间更新/删除
    try {
        if (note.frequency === 'once') {
            await db.execute("DELETE FROM notes WHERE id = ?", [note.id]);
            notifiedMap.delete(note.id);
            console.log(`单次任务已删除，ID: ${note.id}`);
        } else if (note.frequency === 'daily') {
            const nextReminder = calculateNextReminder(remindTime, 24 * 60 * 60 * 1000);
            await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
            console.log(`每日任务已更新下次时间，ID: ${note.id}，新时间: ${nextReminder.toISOString()}`);
        } else if (note.frequency === 'weekly') {
            const nextReminder = calculateNextReminder(remindTime, 7 * 24 * 60 * 60 * 1000);
            await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
            console.log(`每周任务已更新下次时间，ID: ${note.id}，新时间: ${nextReminder.toISOString()}`);
        }
    } catch (err) {
        console.warn('更新任务时间失败:', err);
    }

    return true;
}

/**
 * 轮询检查过期任务并触发提醒
 * 只负责调度，通知和时间更新由 triggerNoteReminder 统一处理
 */
async function processExpiredNotes(db: Database) {
    try {
        const notes = await db.select("SELECT * FROM notes") as any[];
        const currentTime = Date.now();

        for (const note of notes) {
            if (!note.remind_at) continue;
            const remindTime = new Date(note.remind_at).getTime();
            if (remindTime <= currentTime) {
                await triggerNoteReminder(db, note);
            }
        }
    } catch (err) {
        console.warn('轮询检查过期任务失败:', err);
    }
}

// 计算下一次提醒时间的函数
// 保证返回的时间一定严格在当前时间之后
function calculateNextReminder(remindTime: number, interval: number): Date {
    const currentTime = Date.now();
    const originalDate = new Date(remindTime);

    // 原始计划的时分秒
    const originalHours = originalDate.getHours();
    const originalMinutes = originalDate.getMinutes();
    const originalSeconds = originalDate.getSeconds();

    // 构造候选时间：下一个周期的原始时间点
    // 从原始 remindTime 开始，按 interval 递增直到超过当前时间
    let next = new Date(remindTime);
    while (next.getTime() <= currentTime) {
        next = new Date(next.getTime() + interval);
    }

    // 保持时分秒与原始计划一致
    next.setHours(originalHours, originalMinutes, originalSeconds, 0);

    // 如果调整时分秒后又落到了当前时间或之前，再推一个周期
    if (next.getTime() <= currentTime) {
        next = new Date(next.getTime() + interval);
        next.setHours(originalHours, originalMinutes, originalSeconds, 0);
    }

    return next;
}

import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

/**
 * 检查当前是否已开启开机自启
 * 可以在 UI 组件挂载时调用，用来初始化 Checkbox 或 Switch 的状态
 */
async function checkAutostartStatus(): Promise<boolean> {
  try {
    const res = await isEnabled();
    console.log('当前开机自启状态:', res);
    return res;
  } catch (err) {
    console.error('获取自启状态失败:', err);
    return false;
  }
}

/**
 * 切换开机自启状态
 * @param shouldEnable 是否开启
 */
async function toggleAutostart(shouldEnable: boolean) {
  try {
    if (shouldEnable) {
      await enable();
      console.log('已设置开机自启 [SUCCESS]');
    } else {
      await disable();
      console.log('已取消开机自启 [DISABLED]');
    }
  } catch (err) {
    console.error('设置自启失败:', err);
  }
}
// 统一启动入口
window.addEventListener("DOMContentLoaded", setupApp);