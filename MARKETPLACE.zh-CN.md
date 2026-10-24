# Neat CSV - Spreadsheet Editor

[English](MARKETPLACE.md) | 简体中文

在 VS Code 中快速打开大型 CSV、TSV。在熟悉的表格模式下选择、编辑、筛选和排序，也可切换到文本模式，按列着色、对齐并进行块编辑。

## 在表格模式下操作

复制、粘贴、填充和查找替换（拖选单元格，右击打开菜单）。

![选中单元格并打开右键菜单](docs/images/copy-options.png)

双击编辑单元格，支持长文字和多行内容（Enter 确认，Shift+Enter 换行，Escape 取消）。

![双击编辑单元格中的多行文字](docs/images/edit-multiline.png)

## 在文本模式下编辑

切换表格与文本模式（右上角 **T** 进入文本，表格图标返回）。文本按列着色，可选对齐（**View → Align** 或右上角对齐图标）。多行内容可折叠为一行（**View → Fold multiline** 或右上角折叠图标；关闭后编辑换行）。

块编辑可同时修改多行（Mac 按住 **Option**、Windows/Linux 按住 **Alt** 跨行拖选，即可同步输入、删除；**Escape** 返回单光标）。

![跨多行选择文字进行块编辑](docs/images/text-block-edit.png)

## 选择需要的数据

行、列、单元格均支持连续和不连续多选（**Shift + 点击**扩展连续选区；Mac **Cmd + 点击**、Windows/Linux **Ctrl + 点击**添加或取消不连续选择）。

选择多行（点击或拖动行号，配合上述快捷键）。

![选中多行数据](docs/images/select-rows.png)

选择多列（点击或拖动列标题；左上角 **#** 选中全表）。

![选中多列数据](docs/images/select-columns.png)

选择分散的单元格（Cmd/Ctrl + 点击）。

![选中不连续的单元格](docs/images/select-cells.png)

## 筛选和排序

组合多列筛选，支持文字、数字、枚举值和正则表达式（点击表头漏斗，设置条件，点击 **Apply**）。

![组合多个列的筛选条件](docs/images/filters.png)

按数字或文字排序（单击排序图标设置；双击循环切换升序、降序、原始顺序）。

![列的排序选项](docs/images/sorting.png)

## 行列操作

固定行列，滚动时保持可见（双击拖动按钮固定或取消）。插入、删除行列（右击行号或列标题），修改列名（双击表头非按钮区域）。

![固定行列后滚动查看数据](docs/images/pin-rows-columns.png)

调整行列顺序（按住行号旁或表头内的拖动按钮，拖至插入线后释放）。

![拖动列时的悬浮预览](docs/images/reorder-columns-native.png)

## 选区统计

选区统计包括总和、平均值、最小值、最大值和数量（选中后在底部查看，或点击 **Calculate**）。

![表格底部的选区统计](docs/images/selection-statistics.png)

## 检查和清理数据

检查空单元格、重复值和列数不一致的记录（**Data → Check data** 选择类型，点击 **Run check**）。批量填充问题单元格（勾选结果或 **Select listed results**，右击选区 → **Fill selection**）。

![选中检查结果中的空单元格，并打开包含填充操作的右键菜单](docs/images/data-check-empty-cells.png)

## 极速打开大文件

大文件也能快速打开。渐进加载，尽早显示可浏览的数据，无需等待整个文件加载完成。

![浏览大型 CSV 文件](docs/images/large-file.png)

## 保存、导出和恢复

修改和新增单元格以浅红色高亮。编辑及行列调整均可撤销、重做（**Edit → Undo / Redo** 或顶部箭头；Mac **Cmd+Z / Cmd+Shift+Z**，Windows/Linux **Ctrl+Z / Ctrl+Shift+Z**）。

**Save** 保存修改及手动调整的行列顺序（**File → Save**，或 **Cmd+S / Ctrl+S**）。**Save As** 另存副本（**File → Save As**）。**Export current view** 导出筛选、排序后的可见数据（**File → Export current view**，选择位置）。固定行列仅影响视图。

覆盖前自动备份，在存储限额内每个文件保留最近 **5 个版本**。可恢复旧版本，也可查找已移动文件的备份（**File → Recover** 浏览、恢复、清理；**Settings → Backup settings** 调整设置）。

## 随手查看 Tips

悬停单元格、表头或按钮，顶部蓝色 Tips 即显示单击、双击、拖动和右击的操作说明。向导也会介绍提示区（右上角 **?** 或 **View → Quick guide** 重看向导）。

![顶部菜单旁的蓝色 Tips 显示选择和编辑单元格的操作说明](docs/images/operation-tips.png)

## 深色模式

随时切换明暗主题（点击最右侧主题图标或 **View → Switch color theme**），自动记住你的选择。

![深色表格中的选区和统计](docs/images/dark-mode.png)

## 其他功能

- 全文件或选区查找替换（**Edit → Find and replace** 选择范围）。
- 调整行高、列宽（拖动分割线调整，双击适应内容）。
- 显隐列、跳转行（**View → Show / hide columns** 或 **Go to row**）。
- 识别网址及文字中的链接（点击在浏览器打开）。
- 无表头文件、多种编码和分隔符（**View → First row as headers** 切换表头；**Data → File format** 设置格式）。
- 中英文界面（**Settings → Language** 切换）。

## 开始使用

安装后打开 CSV 或 TSV。若由其他编辑器打开，通过 **Reopen Editor With** 选择 **Neat CSV**。需要桌面版 VS Code 1.95+。
