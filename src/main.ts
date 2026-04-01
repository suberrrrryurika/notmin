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

        // 3. 渲染笔记列表
        await renderNotes(db);
        setupSidebar();
        // 4. 绑定保存按钮事件
        const saveBtn = document.getElementById('saveNoteBtn');
        saveBtn?.addEventListener('click', async () => {
            const contentInput = document.getElementById('note-input') as HTMLTextAreaElement;
            const timeInput = document.getElementById('remind-time') as HTMLInputElement;
            const statusLabel = document.getElementById('note-status');

            const content = contentInput.value;
            const remindTime = timeInput.value;

            if (!content) {
                alert("请输入笔记内容");
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
            await renderNotes(db);

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
                    setTimeout(async () => {
                        await invoke('send_task_notification', {
                            title: '任务提醒',
                            message: content
                        });
                    }, delayMs);
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

        // 定时器：每 10 秒检查一次过期的提醒并更新界面
        setInterval(async () => {
            const db = await Database.load("sqlite:tasks.db");
            await renderNotes(db);  // 只更新那些需要更新的任务
        }, 10000);

    } catch (err) {
        console.error("致命错误: 插件未找到或权限被拒绝", err);
        const container = document.getElementById('notes-container');
        if (container) container.innerText = "数据库加载失败，请检查配置。";
    }
}
// 渲染笔记列表
async function renderNotes(db: Database) {
    const container = document.getElementById('notes-container');
    if (!container) return;

    try {
        // 从数据库读取所有笔记，按 ID 倒序（最新的在最前）
        const notes = await db.select("SELECT * FROM notes ORDER BY id DESC") as any[];

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

            // 过滤过期笔记
            const remindTime = new Date(note.remind_at).getTime();
            if (remindTime < currentTime) {
                if (note.frequency === 'once') {
                    // 单次任务，直接删除
                    await db.execute("DELETE FROM notes WHERE id = ?", [note.id]);
                    console.log(`任务已删除，ID: ${note.id}`);
                } else if (note.frequency === 'daily') {
                    // 处理每日任务
                    const nextReminder = calculateNextReminder(remindTime, 24 * 60 * 60 * 1000);  // 每日任务
                    await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
                    console.log(`已更新每日任务的提醒时间: ${nextReminder.toISOString()}`);
                } else if (note.frequency === 'weekly') {
                    // 处理每周任务
                    const nextReminder = calculateNextReminder(remindTime, 7 * 24 * 60 * 60 * 1000);  // 每周任务
                    await db.execute("UPDATE notes SET remind_at = ? WHERE id = ?", [nextReminder.toISOString(), note.id]);
                    console.log(`已更新每周任务的提醒时间: ${nextReminder.toISOString()}`);
                }
            }

            // 频率值映射
            const freqValue = note.frequency || 'once';
            const freqLabel = frequencyMap[freqValue] || '未知指令';

            noteElement.setAttribute('data-freq', freqValue);

            noteElement.innerHTML = `
    <div class="note-header">
        <span class="quest-status ${freqValue}">[ ${freqLabel} ]</span>
        <span class="note-content">${note.content}</span>
        <button class="delete-btn" data-id="${note.id}">删除</button> <!-- 删除按钮 -->
    </div>
    <div class="note-meta">
        <span class="meta-label">NEXT_SYNC:</span> 
        <span class="meta-value">${note.remind_at ? formatDateWithoutSeconds(note.remind_at) : 'STANDBY'}</span>
    </div>
`;

            // 删除按钮点击事件
            const deleteBtn = noteElement.querySelector('.delete-btn');
            deleteBtn?.addEventListener('click', async () => {
                // 删除数据库中的任务
                const taskId = (deleteBtn as HTMLButtonElement).getAttribute('data-id');
                if (taskId) {
                    await db.execute("DELETE FROM notes WHERE id = ?", [taskId]);
                    console.log(`任务已删除，ID: ${taskId}`);

                    // 重新渲染任务列表
                    await renderNotes(db);
                }
            });

            container.appendChild(noteElement);
        }

    } catch (err) {
        console.error("加载列表失败:", err);
        container.innerHTML = '<div class="error-msg">数据同步中断，请稍后重试。</div>';
    }
}

// 计算下一次提醒时间的函数
function calculateNextReminder(remindTime: number, interval: number): Date {
    const currentTime = new Date().getTime();
    let nextReminder = new Date(remindTime);

    // 获取原定的小时、分钟、秒
    const originalHours = nextReminder.getHours();
    const originalMinutes = nextReminder.getMinutes();
    const originalSeconds = nextReminder.getSeconds();

    const timeDiff = currentTime - remindTime;

    // 如果错过了提醒，计算下一个提醒时间
    if (timeDiff >= 0 && timeDiff < interval) {
        nextReminder = new Date(currentTime);
        nextReminder.setHours(originalHours, originalMinutes, originalSeconds, 0);  // 设置为今天的时间

        if (nextReminder.getTime() < currentTime) {
            nextReminder = new Date(nextReminder.getTime() + interval); // 设置为下一个周期
            nextReminder.setHours(originalHours, originalMinutes, originalSeconds, 0);
        }
    } else {
        nextReminder = new Date(currentTime + interval); // 设置为当前时间后的一个周期
        nextReminder.setHours(originalHours, originalMinutes, originalSeconds, 0);
    }

    return nextReminder;
}
// 统一启动入口
window.addEventListener("DOMContentLoaded", setupApp);