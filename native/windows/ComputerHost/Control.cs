using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace GrayCode.ComputerHost {
  // 控制权和停止信号由消息线程管理，观察或 UIA 调用阻塞时仍能接收接管输入。
  internal sealed class ControlState : NativeWindow, IDisposable {
    private readonly Mutex desktopMutex;
    private readonly SynchronizationContext dispatcher;
    private readonly object gate=new object();
    private readonly Win32.HookProc keyboardCallback,mouseCallback;
    private readonly ControlBanner banner;
    private IntPtr keyboardHook,mouseHook;
    private bool mutexOwned;
    internal volatile bool Active;
    private int generation;
    private string leaseId,owner,reason="idle";
    private readonly Dictionary<long,WindowIdentity> targets=new Dictionary<long,WindowIdentity>();
    internal readonly bool HotkeyRegistered;
    internal event Action<object> Changed;

    internal ControlState() {
      CreateHandle(new CreateParams { Caption="GrayCode Computer Control",Parent=new IntPtr(-3) });
      dispatcher=SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
      desktopMutex=new Mutex(false,"Local\\GrayCode.ComputerControl.Session."+Process.GetCurrentProcess().SessionId);
      keyboardCallback=Keyboard;mouseCallback=Mouse;
      keyboardHook=Win32.SetWindowsHookEx(Win32.KeyboardHook,keyboardCallback,Win32.GetModuleHandle(null),0);
      mouseHook=Win32.SetWindowsHookEx(Win32.MouseHook,mouseCallback,Win32.GetModuleHandle(null),0);
      HotkeyRegistered=Win32.RegisterHotKey(Handle,1,0x4000|0x0001|0x0002,0x1B);
      if(keyboardHook==IntPtr.Zero||mouseHook==IntPtr.Zero)throw new ComputerException("INPUT_OBSERVER_UNAVAILABLE","无法监听用户接管输入。");
      banner=new ControlBanner(delegate{Stop("user_input");});
    }
    internal object Status() { lock(gate)return new { active=Active,leaseId=leaseId,owner=owner,reason=reason,generation=generation,stopShortcut="Ctrl+Alt+Esc",stopShortcutRegistered=HotkeyRegistered }; }
    internal object Acquire(string requestedOwner,IEnumerable<string> windows) {
      DesktopWindows.RequireInteractive();var expectedGeneration=generation;
      var selected=new List<WindowIdentity>();
      foreach(var id in windows) { var window=DesktopWindows.Parse(id);selected.Add(DesktopWindows.Describe(window,false)); }
      if(selected.Count==0)throw new ComputerException("TARGET_REQUIRED","取得控制权时必须选择至少一个窗口。");
      lock(gate) {
        if(Active) {
          if(owner!=requestedOwner)throw new ComputerException("CONTROL_BUSY","另一任务正在控制桌面，请先停止或接管。");
          return Status();
        }
      }
      ComputerException failure=null;
      dispatcher.Send(delegate(object ignored) {
        lock(gate) {
          if(generation!=expectedGeneration){failure=new ComputerException("CONTROL_RELEASED","取得控制权期间已收到停止请求。");return;}
          bool acquired=false;try { acquired=desktopMutex.WaitOne(0); } catch(AbandonedMutexException) { acquired=true; }
          if(!acquired){failure=new ComputerException("CONTROL_BUSY","另一 GrayCode 进程正在控制本桌面。");return;}
          targets.Clear();foreach(var item in selected)targets[long.Parse(item.id,System.Globalization.CultureInfo.InvariantCulture)]=item;
          mutexOwned=true;owner=requestedOwner;leaseId=Guid.NewGuid().ToString("N");reason="acquired";generation++;Active=true;
        }
        banner.Display();
      },null);
      if(failure!=null)throw failure;
      Publish();return Status();
    }
    internal int Require(string expectedLease,IntPtr window) {
      DesktopWindows.RequireInteractive();
      lock(gate) {
        if(!Active||leaseId!=expectedLease)throw new ComputerException("CONTROL_RELEASED","控制权已停止或被用户接管。");
        var target=window;var allowed=false;
        for(var count=0;target!=IntPtr.Zero&&count<16;count++,target=Win32.GetWindow(target,4)) {
          WindowIdentity granted;if(!targets.TryGetValue(target.ToInt64(),out granted))continue;
          var current=DesktopWindows.Describe(target,false);
          if(current.processId!=granted.processId||current.processStartedAt!=granted.processStartedAt)throw new ComputerException("TARGET_REPLACED","获准窗口的进程身份已经变化，请重新选择窗口。");
          allowed=true;break;
        }
        if(!allowed)throw new ComputerException("TARGET_NOT_GRANTED","该窗口不在本次取得控制权的范围内。");
        return generation;
      }
    }
    internal void Check(int expectedGeneration) { if(!Active||generation!=expectedGeneration)throw new ComputerException("CONTROL_RELEASED","操作已停止，后续输入没有继续发送。"); }
    internal void Stop(string stopReason) {
      bool release;
      lock(gate) { Active=false;generation++;reason=stopReason;leaseId=null;owner=null;targets.Clear();release=mutexOwned;mutexOwned=false; }
      InputActions.ReleaseHeld();
      dispatcher.Send(delegate(object ignored){banner.Hide();if(release){try{desktopMutex.ReleaseMutex();}catch(ApplicationException){}}},null);
      Publish();
    }
    private void Publish() { var handler=Changed;if(handler!=null)handler(Status()); }
    private IntPtr Keyboard(int code,IntPtr message,IntPtr data) {
      if(code>=0&&Active) { var item=(Win32.KeyboardData)Marshal.PtrToStructure(data,typeof(Win32.KeyboardData));if(item.Extra.ToUInt64()!=Win32.Marker)Stop("user_input"); }
      return Win32.CallNextHookEx(keyboardHook,code,message,data);
    }
    private IntPtr Mouse(int code,IntPtr message,IntPtr data) {
      if(code>=0&&Active) { var item=(Win32.MouseData)Marshal.PtrToStructure(data,typeof(Win32.MouseData));if(item.Extra.ToUInt64()!=Win32.Marker)Stop("user_input"); }
      return Win32.CallNextHookEx(mouseHook,code,message,data);
    }
    protected override void WndProc(ref Message message) { if(message.Msg==0x0312&&message.WParam.ToInt32()==1)Stop("stop_shortcut");base.WndProc(ref message); }
    public void Dispose() {
      Stop("host_closed");if(keyboardHook!=IntPtr.Zero)Win32.UnhookWindowsHookEx(keyboardHook);if(mouseHook!=IntPtr.Zero)Win32.UnhookWindowsHookEx(mouseHook);
      Win32.UnregisterHotKey(Handle,1);DestroyHandle();banner.Dispose();desktopMutex.Dispose();
    }
  }
}
