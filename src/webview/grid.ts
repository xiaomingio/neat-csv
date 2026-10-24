/*
Mount the CSV editing interface inside the VS Code webview.
*/
import './UiTranslations';
import { CsvGrid } from './CsvGrid';

new CsvGrid(document.getElementById('app')!);
