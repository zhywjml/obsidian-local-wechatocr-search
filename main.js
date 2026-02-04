const obsidian = require('obsidian');

module.exports = class OCRSearchPlugin extends obsidian.Plugin {
    async onload() {
        console.log('🔍 微信OCR全库搜索(溯源版)已加载');

        this.indexData = await this.loadData() || { images: {} };
        this.queue = [];
        this.isProcessing = false;
        this.statusBar = this.addStatusBarItem();
        this.updateStatusBar();

        // 1. 搜索命令
        this.addCommand({
            id: 'search-image-text',
            name: '🔍 全局搜索图片文字 (Visual Search)',
            callback: () => {
                new OCRSplitSearchModal(this.app, this.indexData.images).open();
            }
        });

        // 2. 重建索引命令
        this.addCommand({
            id: 'rebuild-ocr-index',
            name: '🔄 重建图片索引 (Rebuild Index)',
            callback: () => {
                this.scanVault(true);
            }
        });

        this.registerEvent(this.app.vault.on('create', (file) => this.checkFile(file)));
        this.registerEvent(this.app.vault.on('modify', (file) => this.checkFile(file)));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (this.indexData.images[file.path]) {
                delete this.indexData.images[file.path];
                this.saveData(this.indexData);
            }
        }));

        this.app.workspace.onLayoutReady(() => {
            this.scanVault();
        });
    }

    // --- 索引逻辑 ---
    async scanVault(force = false) {
        const files = this.app.vault.getFiles();
        let added = 0;
        for (const file of files) {
            if (this.isImage(file)) {
                const cached = this.indexData.images[file.path];
                if (force || !cached || cached.mtime !== file.stat.mtime) {
                    this.queue.push(file);
                    added++;
                }
            }
        }
        if (added > 0) {
            new obsidian.Notice(`🔍 OCR: 发现 ${added} 张图片待处理...`);
            this.processQueue();
        }
    }

    checkFile(file) {
        if (this.isImage(file)) {
            this.queue.push(file);
            this.processQueue();
        }
    }

    isImage(file) {
        return ['png', 'jpg', 'jpeg', 'bmp'].includes(file.extension?.toLowerCase());
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        
        while (this.queue.length > 0) {
            const file = this.queue.shift();
            this.updateStatusBar(`OCR 处理中: ${this.queue.length} left`);
            try {
                const result = await this.fetchOCR(file);
                if (result) {
                    this.indexData.images[file.path] = {
                        mtime: file.stat.mtime,
                        width: result.width,
                        height: result.height,
                        items: result.items
                    };
                    await this.saveData(this.indexData);
                }
            } catch (err) {
                console.error(`OCR Fail: ${file.path}`, err);
            }
            await new Promise(r => setTimeout(r, 200));
        }
        this.isProcessing = false;
        this.updateStatusBar();
        new obsidian.Notice("✅ 图片索引更新完毕");
    }

    async fetchOCR(file) {
        const adapter = this.app.vault.adapter;
        const fullPath = adapter.getFullPath(file.path);
        try {
            const response = await fetch("http://127.0.0.1:12345/ocr", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ "image_path": fullPath })
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (e) { return null; }
    }

    updateStatusBar(msg = "") {
        if (msg) this.statusBar.setText(`🔄 ${msg}`);
        else this.statusBar.setText(`🖼️ OCR 索引: ${Object.keys(this.indexData.images).length}`);
    }
};

// --- UI 类：左右分栏搜索 ---
class OCRSplitSearchModal extends obsidian.Modal {
    constructor(app, index) {
        super(app);
        this.index = index;
        this.searchResults = [];
        this.currentQuery = "";
    }

    onOpen() {
        this.modalEl.addClass("ocr-search-modal");
        const { contentEl } = this;
        contentEl.empty();

        // Header
        const header = contentEl.createDiv({ cls: "ocr-search-header" });
        const searchInput = header.createEl("input", { 
            type: "text", 
            cls: "ocr-search-input", 
            placeholder: "输入文字搜索图片... (支持空格分词)" 
        });
        searchInput.focus();

        // Body
        const body = contentEl.createDiv({ cls: "ocr-search-body" });
        this.listEl = body.createDiv({ cls: "ocr-result-list" });
        this.renderEmptyState("请输入关键词开始搜索");

        this.previewPane = body.createDiv({ cls: "ocr-preview-pane" });
        this.previewPane.createDiv({ cls: "ocr-empty-state", text: "👈 点击左侧结果预览图片" });

        searchInput.addEventListener("input", (e) => {
            this.currentQuery = e.target.value;
            this.performSearch(this.currentQuery);
        });
    }

    performSearch(query) {
        this.listEl.empty();
        if (!query.trim()) {
            this.renderEmptyState("请输入关键词");
            return;
        }

        const lowerQuery = query.toLowerCase().trim();
        this.searchResults = [];

        for (const [path, data] of Object.entries(this.index)) {
            if (!data.items) continue;
            const matches = data.items.filter(item => 
                item.text.toLowerCase().includes(lowerQuery)
            );

            if (matches.length > 0) {
                this.searchResults.push({
                    path: path,
                    matches: matches,
                    rawData: data
                });
            }
        }
        this.renderList();
    }

    renderList() {
        if (this.searchResults.length === 0) {
            this.renderEmptyState("没有找到匹配图片");
            return;
        }

        this.searchResults.forEach(res => {
            const itemEl = this.listEl.createDiv({ cls: "ocr-result-item" });
            itemEl.createDiv({ cls: "ocr-result-name", text: res.path.split('/').pop() });
            const previewText = res.matches[0].text;
            itemEl.createDiv({ cls: "ocr-result-preview", text: `匹配: "${previewText}"...` });

            itemEl.onclick = () => {
                this.listEl.querySelectorAll(".ocr-result-item").forEach(el => el.removeClass("is-selected"));
                itemEl.addClass("is-selected");
                this.showImage(res);
            };
        });
    }

    showImage(result) {
        this.previewPane.empty();
        
        const file = this.app.vault.getAbstractFileByPath(result.path);
        if (!file) {
            this.previewPane.createDiv({ text: "❌ 图片文件已丢失" });
            return;
        }

        const container = this.previewPane.createDiv({ cls: "ocr-img-container" });
        const img = container.createEl("img", { cls: "ocr-preview-img" });
        img.src = this.app.vault.getResourcePath(file);

        // 双击图片：直接打开图片文件
        img.ondblclick = () => {
            this.app.workspace.getLeaf(true).openFile(file);
            this.close();
        };

        // 画框
        img.onload = () => {
            const naturalW = result.rawData.width;
            const naturalH = result.rawData.height;
            const displayW = img.clientWidth;
            const displayH = img.clientHeight;

            if (!naturalW || !naturalH) return;
            const scaleX = displayW / naturalW;
            const scaleY = displayH / naturalH;

            result.matches.forEach(match => {
                const loc = match.location;
                const box = container.createDiv({ cls: "ocr-highlight-box" });
                box.style.left = `${loc.left * scaleX}px`;
                box.style.top = `${loc.top * scaleY}px`;
                box.style.width = `${(loc.right - loc.left) * scaleX}px`;
                box.style.height = `${(loc.bottom - loc.top) * scaleY}px`;
                box.title = match.text;
            });
        };

        // ✅ 调用：渲染底部引用链接
        this.renderBacklinks(file);
    }

// --- 最终增强版：渲染引用链接 (支持跳转到具体行) ---
    renderBacklinks(imageFile) {
        // 1. 清理旧的引用栏
        const existingBar = this.previewPane.querySelector(".ocr-ref-bar");
        if (existingBar) existingBar.remove();

        const refBar = this.previewPane.createDiv({ cls: "ocr-ref-bar" });
        const referencingFiles = new Set();

        // 2. 获取引用关系
        const allResolvedLinks = this.app.metadataCache.resolvedLinks;
        for (const [sourcePath, targets] of Object.entries(allResolvedLinks)) {
            if (targets.hasOwnProperty(imageFile.path)) {
                referencingFiles.add(sourcePath);
            }
        }

        // 3. 渲染 UI
        if (referencingFiles.size === 0) {
            refBar.createSpan({ cls: "ocr-ref-none", text: "孤立图片 (未被引用)" });
        } else {
            refBar.createSpan({ cls: "ocr-ref-label", text: "🔗 引用来源:" });
            
            referencingFiles.forEach(path => {
                const noteFile = this.app.vault.getAbstractFileByPath(path);
                if (!noteFile) return;

                const linkBtn = refBar.createEl("a", { 
                    cls: "ocr-ref-link", 
                    text: `📄 ${noteFile.basename}`, // 只显示文件名
                    href: "#"
                });

                // --- 🖱️ 点击跳转核心逻辑 ---
                linkBtn.onclick = async (e) => {
                    e.preventDefault();
                    
                    // 1. 读取目标笔记的全文内容
                    const content = await this.app.vault.read(noteFile);
                    const lines = content.split('\n');
                    
                    // 2. 寻找图片所在的行号
                    // 我们查找包含图片文件名的那一行 (例如 "image.png")
                    let targetLine = 0;
                    for (let i = 0; i < lines.length; i++) {
                        // 只要这一行包含了图片的文件名，就认为是目标行
                        if (lines[i].includes(imageFile.name)) {
                            targetLine = i;
                            break; 
                        }
                    }

                    // 3. 打开文件并滚动到指定行
                    const leaf = this.app.workspace.getLeaf(true); // true 表示在新标签页打开
                    await leaf.openFile(noteFile, {
                        eState: { 
                            line: targetLine // ✨ 魔法参数：告诉 Obsidian 滚动到哪一行
                        },
                        active: true // 激活该窗口
                    });

                    // 4. 关闭搜索弹窗
                    this.close(); 
                };
            });
        }
    }

    renderEmptyState(text) {
        this.listEl.createDiv({ cls: "ocr-empty-state", text: text });
    }

    onClose() {
        this.contentEl.empty();
    }
}