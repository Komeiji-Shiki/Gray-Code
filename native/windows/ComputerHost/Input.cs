using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace GrayCode.ComputerHost {
  internal static class InputActions {
    private static readonly object gate=new object();
    private static readonly HashSet<ushort> held=new HashSet<ushort>();
    private static uint mouseHeld;
    private static Win32.Input Key(ushort key,ushort scan,uint flags) {return new Win32.Input {Type=1,Value=new Win32.InputUnion {Keyboard=new Win32.KeyInput {Key=key,Scan=scan,Flags=flags,Extra=new UIntPtr(Win32.Marker)}}};}
    private static Win32.Input Mouse(uint flags,uint data=0,int x=0,int y=0) {return new Win32.Input {Type=0,Value=new Win32.InputUnion {Mouse=new Win32.MouseInput {X=x,Y=y,Data=data,Flags=flags,Extra=new UIntPtr(Win32.Marker)}}};}
    private static void Send(params Win32.Input[] values) {
      var sent=Win32.SendInput((uint)values.Length,values,Marshal.SizeOf(typeof(Win32.Input)));
      if(sent!=values.Length)throw new ComputerException("INPUT_REJECTED","系统未接受全部输入，可能与目标进程权限有关；结果需要重新观察。");
    }
    internal static void ReleaseHeld() {
      lock(gate) {
        foreach(var key in held) {var value=Key(key,0,2);Win32.SendInput(1,new[]{value},Marshal.SizeOf(typeof(Win32.Input)));}
        held.Clear();
        if(mouseHeld!=0) {var value=Mouse(mouseHeld);Win32.SendInput(1,new[]{value},Marshal.SizeOf(typeof(Win32.Input)));mouseHeld=0;}
      }
    }
    private static void RequireTarget(IntPtr window,int x,int y) {
      Win32.Rect bounds;if(!Win32.GetWindowRect(window,out bounds)||x<bounds.Left||x>=bounds.Right||y<bounds.Top||y>=bounds.Bottom)
        throw new ComputerException("POINT_OUTSIDE_WINDOW","坐标不在目标窗口内。");
      var actual=Win32.WindowFromPoint(new Win32.Point {X=x,Y=y});
      if(!DesktopWindows.SameRoot(actual,window))throw new ComputerException("TARGET_OCCLUDED","该位置被其他窗口遮挡，请重新观察。");
    }
    private static void Move(IntPtr window,int x,int y,ControlState control,int generation) {
      control.Check(generation);RequireTarget(window,x,y);
      var left=Win32.GetSystemMetrics(76);var top=Win32.GetSystemMetrics(77);var width=Win32.GetSystemMetrics(78);var height=Win32.GetSystemMetrics(79);
      if(width<2||height<2)throw new ComputerException("DESKTOP_UNAVAILABLE","无法读取显示器坐标范围。");
      Send(Mouse(0x8000|0x4000|0x0001,0,(int)Math.Round((x-left)*65535.0/(width-1)),(int)Math.Round((y-top)*65535.0/(height-1))));
    }
    internal static object Perform(ControlState control,Observation observation,Dictionary<string,object> args) {
      var window=DesktopWindows.Parse(observation.window.id);var generation=control.Require(Json.Text(args,"leaseId"),window);var action=Json.Text(args,"action");
      DesktopWindows.Verify(observation.window,action!="focusWindow",action=="focusWindow");control.Check(generation);
      if(action=="focusWindow") {
        if(Win32.IsIconic(window))Win32.ShowWindow(window,9);
        if(!Win32.SetForegroundWindow(window))throw new ComputerException("FOCUS_REJECTED","系统没有把焦点交给目标窗口，请由用户切换后重新观察。");
        return new {performed=true,method="win32",action=action};
      }
      ElementRecord element=null;var elementId=Json.Text(args,"elementId");
      if(elementId.Length>0)element=AutomationState.Element(observation,elementId);
      if(action=="invoke"||action=="setValue"||action=="select"||action=="toggle"||action=="expand"||action=="collapse"||action=="focusElement") {
        if(element==null)throw new ComputerException("ELEMENT_REQUIRED","结构化操作需要本次观察返回的控件 ID。");
        control.Check(generation);return AutomationState.PerformPattern(element,action,Json.Text(args,"text"));
      }
      if(action=="type"||action=="key") {
        AutomationState.VerifyFocus(observation);
        if(AutomationState.FocusIsPassword())throw new ComputerException("SENSITIVE_INPUT","密码与认证内容请由用户输入。");
        if(action=="type")return Type(Json.Text(args,"text"),control,generation,window);
        return Press(Json.Text(args,"key"),control,generation);
      }
      if(action!="click"&&action!="scroll"&&action!="drag")throw new ComputerException("ACTION_UNSUPPORTED","不支持的电脑操作。");
      var x=element!=null?(element.NativeBounds.Left+element.NativeBounds.Right)/2:Json.Number(args,"x",int.MinValue);
      var y=element!=null?(element.NativeBounds.Top+element.NativeBounds.Bottom)/2:Json.Number(args,"y",int.MinValue);
      Move(window,x,y,control,generation);
      try {
        if(action=="click") {
          var button=Json.Text(args,"button","left");var down=button=="right"?8u:button=="middle"?32u:2u;var up=down*2;
          var count=Math.Max(1,Math.Min(2,Json.Number(args,"clickCount",1)));
          for(var i=0;i<count;i++) {control.Check(generation);Send(Mouse(down),Mouse(up));if(count>1)Thread.Sleep(80);}
        } else if(action=="scroll") {
          var dy=Math.Max(-20,Math.Min(20,Json.Number(args,"scrollY")));var dx=Math.Max(-20,Math.Min(20,Json.Number(args,"scrollX")));
          control.Check(generation);if(dy!=0)Send(Mouse(0x0800,unchecked((uint)(-dy*120))));if(dx!=0)Send(Mouse(0x1000,unchecked((uint)(dx*120))));
        } else if(action=="drag") {
          var endX=Json.Number(args,"toX",int.MinValue);var endY=Json.Number(args,"toY",int.MinValue);RequireTarget(window,endX,endY);
          var duration=Math.Max(50,Math.Min(5000,Json.Number(args,"durationMs",500)));var steps=Math.Max(2,duration/16);
          lock(gate){control.Check(generation);mouseHeld=4;Send(Mouse(2));}
          for(var i=1;i<=steps;i++) {Move(window,x+(endX-x)*i/steps,y+(endY-y)*i/steps,control,generation);Thread.Sleep(duration/steps);}
          lock(gate){control.Check(generation);Send(Mouse(4));mouseHeld=0;}
        } else throw new ComputerException("ACTION_UNSUPPORTED","不支持的电脑操作。");
      } finally {ReleaseHeld();}
      return new {performed=true,method="sendInput",action=action};
    }
    private static object Type(string text,ControlState control,int generation,IntPtr window) {
      if(text.Length>100000)throw new ComputerException("TEXT_TOO_LONG","单次输入文字过长，请分段操作。");
      var count=0;
      // 控件读取通常返回 CRLF，重新输入时只发送一个换行，避免跨应用复制出现空白行。
      foreach(var character in text.Replace("\r\n","\n").Replace("\r","\n")) {
        control.Check(generation);
        if(!DesktopWindows.SameRoot(Win32.GetForegroundWindow(),window))throw new ComputerException("FOCUS_CHANGED","输入期间焦点发生变化，已停止后续输入。");
        Send(Key(0,character,4),Key(0,character,4|2));count++;
      }
      return new {performed=true,method="sendInput",action="type",characters=count};
    }
    private static ushort VirtualKey(string value) {
      if(value.Length==1) {var c=char.ToUpperInvariant(value[0]);if(c>='A'&&c<='Z'||c>='0'&&c<='9')return c;}
      int function;if(value.StartsWith("F",StringComparison.OrdinalIgnoreCase)&&int.TryParse(value.Substring(1),out function)&&function>=1&&function<=24)return (ushort)(111+function);
      switch(value.ToLowerInvariant()) {
        case "control":case "ctrl":return 17;case "shift":return 16;case "alt":return 18;
        case "enter":return 13;case "tab":return 9;case "escape":case "esc":return 27;case "space":return 32;
        case "backspace":return 8;case "delete":return 46;case "insert":return 45;
        case "home":return 36;case "end":return 35;case "pageup":return 33;case "pagedown":return 34;
        case "arrowleft":return 37;case "arrowup":return 38;case "arrowright":return 39;case "arrowdown":return 40;
      }
      throw new ComputerException("KEY_UNSUPPORTED","不支持的按键名称。");
    }
    private static object Press(string combination,ControlState control,int generation) {
      var pieces=combination.Split('+');if(pieces.Length<1||pieces.Length>4)throw new ComputerException("KEY_UNSUPPORTED","按键组合无效。");
      var keys=new List<ushort>();foreach(var piece in pieces)keys.Add(VirtualKey(piece.Trim()));
      try {
        foreach(var key in keys) {lock(gate){control.Check(generation);held.Add(key);Send(Key(key,0,0));}}
      } finally {ReleaseHeld();}
      return new {performed=true,method="sendInput",action="key"};
    }
  }
}
