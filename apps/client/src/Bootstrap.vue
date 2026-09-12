<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue';
import { closeWebBridge, installWebBridge, webRequest } from './webBridge';
import projectLogo from '../../../resources/icon.png';
import WorkspaceLoading from './components/WorkspaceLoading.vue';
const App = defineAsyncComponent({ loader: () => import('./App.vue'), loadingComponent: WorkspaceLoading, errorComponent: WorkspaceLoading, delay: 150 });
const native = Boolean(window.graycode);
const authenticated = ref(native); const loading = ref(!native); const busy = ref(false); const token = ref(''); const error = ref('');
const deviceName = ref(localStorage.getItem('graycode.webDeviceName') ?? '');
const mounted = ref(native);
async function login() {
  if (busy.value) return; busy.value = true; error.value = '';
  try { await webRequest('/auth/login', { token: token.value, ...(deviceName.value.trim() ? { deviceName: deviceName.value.trim() } : {}) }); token.value = ''; localStorage.setItem('graycode.webDeviceName', deviceName.value.trim()); installWebBridge(); authenticated.value = true; mounted.value = true; }
  catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function expired() { authenticated.value = false; closeWebBridge(); error.value = '登录已过期，请重新连接。'; }
onMounted(async () => {
  if (native) return;
  window.addEventListener('graycode:session-expired', expired);
  try { await webRequest('/auth/session'); installWebBridge(); authenticated.value = true; mounted.value = true; error.value = ''; }
  catch (cause) { if ((cause as { status?: number }).status !== 401) error.value = (cause as Error).message; else error.value = ''; }
  finally { loading.value = false; }
});
onBeforeUnmount(() => { window.removeEventListener('graycode:session-expired', expired); if (!native) closeWebBridge(); });
</script>
<template>
  <App v-if="mounted" v-show="authenticated" />
  <main v-if="!authenticated" class="web-login"><section>
    <div class="web-wordmark"><img :src="projectLogo" alt="GrayCode" /><span>GRAY<span>CODE</span></span></div><p class="web-kicker">远程工作台</p>
    <h1>继续你的工作。</h1><p>连接部署电脑上的对话、文件与工具任务。</p>
    <p v-if="loading" role="status">正在连接…</p>
    <form v-else @submit.prevent="login"><label for="access-token">访问令牌</label><input id="access-token" v-model="token" type="password" autocomplete="current-password" autofocus required :disabled="busy" /><label for="web-device-name">设备名称（可选）</label><input id="web-device-name" v-model="deviceName" placeholder="例如：我的手机" maxlength="60" :disabled="busy" />
      <p v-if="error" role="alert" class="login-error">{{ error }}</p><button class="login-connect" :disabled="busy || !token" :aria-busy="busy"><span>{{ busy ? '正在连接…' : '连接工作台' }}</span><span aria-hidden="true">↗</span></button>
    </form>
  </section><div class="login-composition" aria-hidden="true">
    <div class="composition-heading"><span>GRAYCODE</span><span>REMOTE WORKSPACE</span></div>
    <div class="composition-art"><div class="composition-outline"></div><div class="composition-plane"></div><div class="composition-rail"></div><img :src="projectLogo" alt="" /><span class="composition-cross">＋</span></div>
    <div class="composition-caption"><strong>GRAY<span>CODE</span><i>↗</i></strong><div><span>远程工作台</span><span>对话 / 文件 / 工具</span></div></div>
  </div></main>
</template>
<style scoped>
.web-login{min-height:100dvh;display:grid;grid-template-columns:1fr 1fr;background:#111317;color:#e4e7ec;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.web-login section{align-self:center;justify-self:center;width:min(380px,calc(100% - 48px));padding:48px 0}
.web-wordmark{display:flex;align-items:center;gap:13px;font-size:20px;letter-spacing:.16em;font-weight:750}.web-wordmark img{width:34px;height:34px;object-fit:contain}.web-wordmark span span{font-weight:350}
.web-kicker{margin-top:46px;letter-spacing:.12em}.web-login h1{font-size:36px;font-weight:500;margin:15px 0}.web-login p{color:#a0a8b5;font-size:14px;line-height:1.7}
.web-login form{display:grid;gap:12px;margin-top:35px}.web-login label{font-size:12px}.web-login input{padding:13px;border:1px solid #485365;background:#1a1e26;color:inherit;font:inherit;border-radius:0}.web-login input:focus-visible{outline:2px solid #aabacf;outline-offset:2px}
.web-login .login-connect{display:flex;align-items:center;justify-content:space-between;margin-top:8px;padding:14px 16px;border:1px solid #c5d0df;border-radius:0;background:#c5d0df;color:#141b26;font:inherit;font-weight:650;cursor:pointer;opacity:1;transition:none}.web-login .login-connect:hover:not(:disabled){background:#e5ebf3;border-color:#e5ebf3}.web-login .login-connect:focus-visible{outline:2px solid #edf3fc;outline-offset:4px}.web-login .login-connect:disabled{background:#303947;border-color:#566276;color:#bac5d5;cursor:default}.web-login .login-connect span:last-child{font-size:20px;line-height:1}
.login-error{color:#f0a7a7!important;margin:0}
.login-composition{position:relative;overflow:hidden;border-left:1px solid #343e4d;background:#181d26;display:flex;flex-direction:column;padding:40px clamp(28px,4vw,76px);isolation:isolate}
.composition-heading{display:flex;justify-content:space-between;gap:16px;color:#aab7ca;font-size:10px;letter-spacing:.16em;border-top:2px solid #aab7ca;padding-top:14px}
.composition-art{position:relative;flex:1;min-height:360px;margin:34px 0 16px;display:grid;place-items:center;background-image:linear-gradient(#8294ad13 1px,transparent 1px),linear-gradient(90deg,#8294ad13 1px,transparent 1px);background-size:44px 44px}
.composition-outline{position:absolute;width:68%;aspect-ratio:1;border:1px solid #63728a;transform:rotate(-12deg)}.composition-plane{position:absolute;width:100%;height:26%;background:#b0bfd3;transform:rotate(-32deg)}.composition-rail{position:absolute;top:14%;bottom:16%;left:14%;width:15%;background:#313e55;border-top:5px solid #ced9e6}
.composition-art img{position:relative;width:clamp(170px,20vw,278px);height:auto;z-index:1;filter:drop-shadow(16px 20px 0 #0c101680)}.composition-cross{position:absolute;right:3%;top:8%;color:#dbe3ee;font-size:30px;font-weight:200}
.composition-caption{padding-top:18px;border-top:1px solid #485469}.composition-caption strong{display:flex;align-items:baseline;font-size:clamp(36px,5.6vw,90px);line-height:1.1;letter-spacing:-.065em;font-weight:700;color:#dce4f0}.composition-caption strong span{font-weight:300}.composition-caption i{font-size:.62em;font-style:normal;margin-left:auto;letter-spacing:0;color:#9baec8}.composition-caption>div{display:flex;justify-content:space-between;gap:16px;margin-top:18px;color:#aab7ca;font-size:11px;letter-spacing:.1em}
@media(max-width:740px){.web-login{grid-template-columns:1fr}.login-composition{display:none}.web-login section{padding:30px 0}.web-login h1{font-size:32px}}
</style>
