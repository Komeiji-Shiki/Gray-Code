<script setup lang="ts">
/**
 * WelcomePanel - 欢迎面板组件
 *
 * 在聊天视图的初始状态显示，包含：
 * - 欢迎语
 * - 历史对话列表
 *
 * 用户可以在下方输入框输入消息开始新对话
 */

import { CustomScrollbar, AnnouncementModal } from '../common'
import ConversationList from '../history/ConversationList.vue'
import { useChatStore, useSettingsStore } from '@/stores'
import { useI18n } from '@/i18n'

const { t } = useI18n()
const chatStore = useChatStore()
const settingsStore = useSettingsStore()

// 处理选择对话
async function handleSelect(id: string) {
  await chatStore.switchConversation(id)
}

// 处理删除对话
async function handleDelete(id: string) {
  await chatStore.deleteConversation(id)
}
</script>

<template>
  <div class="welcome-panel">
    <!-- 版本更新公告弹窗 -->
    <AnnouncementModal />
    
    <!-- 欢迎区域 -->
    <div class="welcome-section">
      <div class="welcome-content">
        <div class="logo">
          <svg class="logo-svg" viewBox="220 170 580 630" aria-hidden="true">
            <!-- 与开屏动画（Splash.vue）同款的 Gray logo：灰阶色块 + 细描边线稿（完稿态） -->
            <g class="fills">
              <path class="fill-body" d="M 744.0 758.0 L 724.0 723.0 L 704.0 706.0 L 687.0 698.0 L 630.0 684.0 L 625.0 684.0 L 583.0 725.0 L 582.0 719.0 L 517.0 750.0 L 497.0 754.0 L 476.0 753.0 L 455.0 743.0 L 438.0 724.0 L 432.0 697.0 L 436.0 688.0 L 396.0 700.0 L 393.0 720.0 L 382.0 708.0 L 373.0 706.0 L 377.0 742.0 L 345.0 715.0 L 319.0 745.0 L 302.0 784.0 L 751.0 784.0 Z" />
              <path class="fill-body" d="M 588.0 600.0 L 544.0 631.0 L 485.0 655.0 L 485.0 679.0 L 447.0 696.0 L 443.0 701.0 L 446.0 716.0 L 454.0 728.0 L 471.0 740.0 L 482.0 743.0 L 512.0 740.0 L 572.0 714.0 L 585.0 706.0 L 590.0 688.0 L 592.0 653.0 L 588.0 616.0 Z" />
              <path class="fill-hair" d="M 334.0 534.0 L 329.0 587.0 L 332.0 645.0 L 339.0 677.0 L 354.0 710.0 L 364.0 722.0 L 357.0 683.0 L 358.0 657.0 L 369.0 679.0 L 387.0 700.0 L 374.0 641.0 L 372.0 572.0 L 341.0 544.0 Z" />
              <path class="fill-hair" d="M 587.0 408.0 L 601.0 509.0 L 606.0 582.0 L 604.0 651.0 L 596.0 700.0 L 615.0 673.0 L 631.0 639.0 L 647.0 588.0 L 653.0 550.0 L 680.0 532.0 L 690.0 512.0 L 692.0 495.0 L 685.0 475.0 L 678.0 471.0 L 662.0 472.0 L 666.0 443.0 L 673.0 455.0 L 694.0 471.0 L 701.0 487.0 L 701.0 509.0 L 696.0 526.0 L 687.0 541.0 L 672.0 553.0 L 707.0 696.0 L 722.0 706.0 L 742.0 728.0 L 755.0 762.0 L 753.0 694.0 L 737.0 594.0 L 765.0 660.0 L 785.0 760.0 L 790.0 743.0 L 786.0 701.0 L 745.0 532.0 L 728.0 436.0 L 639.0 393.0 L 606.0 404.0 Z" />
              <path class="fill-face" d="M 326.0 374.0 L 306.0 418.0 L 299.0 457.0 L 301.0 493.0 L 310.0 522.0 L 312.0 484.0 L 323.0 450.0 L 329.0 491.0 L 338.0 518.0 L 353.0 542.0 L 369.0 556.0 L 370.0 513.0 L 377.0 480.0 L 411.0 401.0 L 414.0 481.0 L 409.0 477.0 L 402.0 445.0 L 386.0 482.0 L 381.0 506.0 L 393.0 571.0 L 417.0 601.0 L 446.0 622.0 L 481.0 640.0 L 548.0 612.0 L 594.0 577.0 L 588.0 483.0 L 577.0 410.0 L 534.0 413.0 L 483.0 398.0 L 462.0 434.0 L 439.0 460.0 L 466.0 389.0 L 402.0 362.0 L 343.0 352.0 Z" />
              <path class="fill-cap" d="M 230.0 366.0 L 232.0 369.0 L 258.0 355.0 L 292.0 344.0 L 350.0 340.0 L 381.0 344.0 L 424.0 356.0 L 498.0 391.0 L 529.0 401.0 L 567.0 400.0 L 624.0 385.0 L 589.0 364.0 L 527.0 336.0 L 480.0 322.0 L 428.0 314.0 L 365.0 315.0 L 325.0 321.0 L 280.0 334.0 L 240.0 355.0 Z" />
              <path class="fill-cap" d="M 358.0 246.0 L 339.0 313.0 L 380.0 305.0 L 432.0 304.0 L 508.0 318.0 L 565.0 340.0 L 738.0 428.0 L 735.0 349.0 L 723.0 276.0 L 690.0 241.0 L 634.0 207.0 L 562.0 184.0 L 531.0 180.0 L 488.0 181.0 L 456.0 187.0 L 418.0 200.0 L 393.0 213.0 L 364.0 235.0 Z" />
            </g>
            <!-- 线稿层：与色块错开的细描边（对应开屏动画 line-retire 后的完稿态） -->
            <path class="draw-cap" d="M 230.0 366.0 L 232.0 369.0 L 258.0 355.0 L 292.0 344.0 L 350.0 340.0 L 381.0 344.0 L 424.0 356.0 L 498.0 391.0 L 529.0 401.0 L 567.0 400.0 L 624.0 385.0 L 589.0 364.0 L 527.0 336.0 L 480.0 322.0 L 428.0 314.0 L 365.0 315.0 L 325.0 321.0 L 280.0 334.0 L 240.0 355.0 Z M 358.0 246.0 L 339.0 313.0 L 380.0 305.0 L 432.0 304.0 L 508.0 318.0 L 565.0 340.0 L 738.0 428.0 L 735.0 349.0 L 723.0 276.0 L 690.0 241.0 L 634.0 207.0 L 562.0 184.0 L 531.0 180.0 L 488.0 181.0 L 456.0 187.0 L 418.0 200.0 L 393.0 213.0 L 364.0 235.0 Z" />
            <path class="draw-body" d="M 744.0 758.0 L 724.0 723.0 L 704.0 706.0 L 687.0 698.0 L 630.0 684.0 L 625.0 684.0 L 583.0 725.0 L 582.0 719.0 L 517.0 750.0 L 497.0 754.0 L 476.0 753.0 L 455.0 743.0 L 438.0 724.0 L 432.0 697.0 L 436.0 688.0 L 396.0 700.0 L 393.0 720.0 L 382.0 708.0 L 373.0 706.0 L 377.0 742.0 L 345.0 715.0 L 319.0 745.0 L 302.0 784.0 L 751.0 784.0 Z M 588.0 600.0 L 544.0 631.0 L 485.0 655.0 L 485.0 679.0 L 447.0 696.0 L 443.0 701.0 L 446.0 716.0 L 454.0 728.0 L 471.0 740.0 L 482.0 743.0 L 512.0 740.0 L 572.0 714.0 L 585.0 706.0 L 590.0 688.0 L 592.0 653.0 L 588.0 616.0 Z M 334.0 534.0 L 329.0 587.0 L 332.0 645.0 L 339.0 677.0 L 354.0 710.0 L 364.0 722.0 L 357.0 683.0 L 358.0 657.0 L 369.0 679.0 L 387.0 700.0 L 374.0 641.0 L 372.0 572.0 L 341.0 544.0 Z M 587.0 408.0 L 601.0 509.0 L 606.0 582.0 L 604.0 651.0 L 596.0 700.0 L 615.0 673.0 L 631.0 639.0 L 647.0 588.0 L 653.0 550.0 L 680.0 532.0 L 690.0 512.0 L 692.0 495.0 L 685.0 475.0 L 678.0 471.0 L 662.0 472.0 L 666.0 443.0 L 673.0 455.0 L 694.0 471.0 L 701.0 487.0 L 701.0 509.0 L 696.0 526.0 L 687.0 541.0 L 672.0 553.0 L 707.0 696.0 L 722.0 706.0 L 742.0 728.0 L 755.0 762.0 L 753.0 694.0 L 737.0 594.0 L 765.0 660.0 L 785.0 760.0 L 790.0 743.0 L 786.0 701.0 L 745.0 532.0 L 728.0 436.0 L 639.0 393.0 L 606.0 404.0 Z M 326.0 374.0 L 306.0 418.0 L 299.0 457.0 L 301.0 493.0 L 310.0 522.0 L 312.0 484.0 L 323.0 450.0 L 329.0 491.0 L 338.0 518.0 L 353.0 542.0 L 369.0 556.0 L 370.0 513.0 L 377.0 480.0 L 411.0 401.0 L 414.0 481.0 L 409.0 477.0 L 402.0 445.0 L 386.0 482.0 L 381.0 506.0 L 393.0 571.0 L 417.0 601.0 L 446.0 622.0 L 481.0 640.0 L 548.0 612.0 L 594.0 577.0 L 588.0 483.0 L 577.0 410.0 L 534.0 413.0 L 483.0 398.0 L 462.0 434.0 L 439.0 460.0 L 466.0 389.0 L 402.0 362.0 L 343.0 352.0 Z" />
          </svg>
        </div>
        <h1 class="welcome-title">{{ t('components.home.welcome') }}</h1>
        <p class="welcome-subtitle">
          {{ t('components.home.welcomeMessage') }}
        </p>
        <p class="welcome-hint">
          {{ t('components.home.welcomeHint') }}
        </p>
      </div>
    </div>
    
    <!-- 历史对话区域 -->
    <div class="history-section" v-if="chatStore.filteredConversations.length > 0 || chatStore.isLoadingConversations">
      <div class="section-header">
        <h2 class="section-title">{{ t('components.home.recentChats') }}</h2>
        <button class="view-all-btn" @click="settingsStore.showHistory" v-if="!chatStore.isLoadingConversations">
          {{ t('components.home.viewAll') }}
          <i class="codicon codicon-chevron-right"></i>
        </button>
      </div>
      
      <CustomScrollbar class="history-list">
        <ConversationList
          :conversations="chatStore.filteredConversations.slice(0, 8)"
          :current-id="chatStore.currentConversationId"
          :loading="chatStore.isLoadingConversations"
          :format-time="chatStore.formatTime"
          @select="handleSelect"
          @delete="handleDelete"
        />
      </CustomScrollbar>
    </div>
    
    <!-- 无历史时的提示 -->
    <div class="no-history" v-else-if="!chatStore.isLoadingConversations">
      <p class="no-history-text">{{ t('components.home.noRecentChats') }}</p>
    </div>
  </div>
</template>

<style scoped>
.welcome-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--vscode-editor-background);
  overflow: hidden;
}

/* 欢迎区域 */
.welcome-section {
  padding: 32px 24px 24px;
  text-align: center;
  flex-shrink: 0;
}

.welcome-content {
  max-width: 400px;
  margin: 0 auto;
}

.logo {
  width: 56px;
  height: 56px;
  margin: 0 auto 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 14px;
}

.logo .logo-svg {
  width: 40px;
  height: 40px;
  color: var(--vscode-foreground);
  /* 与开屏动画（Splash.vue）同款的灰阶配色：从 currentColor 派生，亮/暗主题自适应 */
  --ink-hair: color-mix(in srgb, var(--vscode-foreground) 92%, var(--vscode-editor-background));
  --ink-cap: color-mix(in srgb, var(--vscode-foreground) 45%, var(--vscode-editor-background));
  --ink-body: color-mix(in srgb, var(--vscode-foreground) 30%, var(--vscode-editor-background));
  --paper: var(--vscode-editor-background);
}

.logo-svg .fill-body {
  fill: var(--ink-body);
}

.logo-svg .fill-hair {
  fill: var(--ink-hair);
}

.logo-svg .fill-face {
  fill: var(--paper);
}

.logo-svg .fill-cap {
  fill: var(--ink-cap);
}

/* 线稿：对应开屏动画 line-retire 后的完稿细描边（stroke 10 / opacity 0.3） */
.logo-svg .draw-cap,
.logo-svg .draw-body {
  fill: none;
  stroke: currentColor;
  stroke-width: 10;
  stroke-linejoin: round;
  stroke-linecap: round;
  opacity: 0.3;
}

.welcome-title {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.welcome-subtitle {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

.welcome-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

/* 历史对话区域 */
.history-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--vscode-panel-border);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  flex-shrink: 0;
}

.section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--vscode-foreground);
  opacity: 0.8;
}

.view-all-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  color: var(--vscode-textLink-foreground);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  transition: background 0.15s;
}

.view-all-btn:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.view-all-btn .codicon {
  font-size: 11px;
}

.history-list {
  flex: 1;
  min-height: 0;
}

/* 无历史提示 */
.no-history {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
}

.no-history-text {
  margin: 0;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
}
</style>