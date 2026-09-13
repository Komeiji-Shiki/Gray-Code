using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace GrayCode.ComputerHost {
  internal sealed class ElementRecord {
    public string id,parentId,name,type,automationId,value;
    public bool enabled,offscreen,password,focused;
    public object bounds;
    public List<string> patterns=new List<string>();
    internal AutomationElement Element;
    public string runtimeId;
    internal Win32.Rect NativeBounds;
  }
  internal sealed class Observation {
    public string id;
    public long capturedAt;
    public WindowIdentity window;
    public List<ElementRecord> elements=new List<ElementRecord>();
    public bool truncated;
    public string accessibilityError,focusedElementId;
  }
  internal static class AutomationState {
    private static readonly object gate=new object();
    private static readonly Dictionary<string,Observation> observations=new Dictionary<string,Observation>();
    private static readonly Queue<string> order=new Queue<string>();
    internal static void Clear() {lock(gate){observations.Clear();order.Clear();}}
    internal static Win32.Rect Bounds(System.Windows.Rect rect) {
      if(rect.IsEmpty)return new Win32.Rect();
      return new Win32.Rect {Left=(int)Math.Round(rect.Left),Top=(int)Math.Round(rect.Top),Right=(int)Math.Round(rect.Right),Bottom=(int)Math.Round(rect.Bottom)};
    }
    private static string Runtime(AutomationElement element) { return string.Join(".",element.GetRuntimeId()); }
    internal static Observation Observe(Dictionary<string,object> args) {
      DesktopWindows.RequireInteractive();
      var window=DesktopWindows.Parse(Json.Text(args,"windowId"));
      var result=new Observation {id=Guid.NewGuid().ToString("N"),capturedAt=Json.Now,window=DesktopWindows.Describe(window,Json.Flag(args,"includeCommandLine",true))};
      var limit=Math.Max(1,Math.Min(1000,Json.Number(args,"maxElements",250)));
      var depth=Math.Max(1,Math.Min(30,Json.Number(args,"maxDepth",14)));
      try {
        var root=AutomationElement.FromHandle(window);
        ReadTree(root,null,0,depth,limit,result);
        // 旧式控件提供方可能把父控件焦点同时报告给滚动条，只采用系统实际焦点的运行标识。
        var focused=AutomationElement.FocusedElement;
        var focusedId=focused==null?null:Runtime(focused);
        foreach(var item in result.elements){item.focused=item.runtimeId==focusedId;if(item.focused)result.focusedElementId=item.id;}
        // 大窗口的树可能截断，仍单独记录属于这个窗口的实际焦点。
        if(result.focusedElementId==null&&focused!=null) {
          var ancestor=focused;var rootId=Runtime(root);
          for(var level=0;ancestor!=null&&level<32;level++) {
            if(Runtime(ancestor)==rootId){ReadTree(focused,null,0,0,limit+1,result);var item=result.elements[result.elements.Count-1];item.focused=true;result.focusedElementId=item.id;break;}
            ancestor=TreeWalker.ControlViewWalker.GetParent(ancestor);
          }
        }
      } catch(ElementNotAvailableException) {result.accessibilityError="窗口控件在读取期间已经变化。";}
      catch(InvalidOperationException error) {result.accessibilityError=error.Message;}
      catch(COMException error) {result.accessibilityError=error.Message;}
      lock(gate) {
        observations[result.id]=result;order.Enqueue(result.id);
        while(order.Count>32)observations.Remove(order.Dequeue());
      }
      return result;
    }
    private static void ReadTree(AutomationElement element,string parent,int level,int depth,int limit,Observation result) {
      if(element==null)return;
      if(result.elements.Count>=limit){result.truncated=true;return;}
      var current=element.Current;
      var item=new ElementRecord {id=result.id+":"+result.elements.Count,parentId=parent,Element=element,runtimeId=Runtime(element),
        name=current.Name,type=current.ControlType.ProgrammaticName.Replace("ControlType.",""),automationId=current.AutomationId,
        enabled=current.IsEnabled,offscreen=current.IsOffscreen,password=current.IsPassword,focused=current.HasKeyboardFocus,NativeBounds=Bounds(current.BoundingRectangle)};
      item.bounds=Json.Rect(item.NativeBounds);
      foreach(var pattern in element.GetSupportedPatterns())item.patterns.Add(pattern.ProgrammaticName.Replace("PatternIdentifiers.Pattern","").Replace("Pattern", ""));
      if(!item.password) {
        object pattern;
        if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
          var value=((ValuePattern)pattern).Current.Value;item.value=value.Length>4000?value.Substring(0,4000):value;
        } else if((item.type=="Document"||item.type=="Edit")&&element.TryGetCurrentPattern(TextPattern.Pattern,out pattern))item.value=((TextPattern)pattern).DocumentRange.GetText(4000);
      }
      result.elements.Add(item);
      if(level>=depth)return;
      var walker=TreeWalker.ControlViewWalker;var child=walker.GetFirstChild(element);
      while(child!=null) {
        try {ReadTree(child,item.id,level+1,depth,limit,result);}catch(ElementNotAvailableException){result.truncated=true;}
        if(result.elements.Count>=limit){result.truncated=true;break;}
        child=walker.GetNextSibling(child);
      }
    }
    internal static Observation Peek(string id) {
      lock(gate) {
        Observation result;if(!observations.TryGetValue(id,out result))throw new ComputerException("OBSERVATION_STALE","观察记录已使用或失效，请重新读取窗口。");
        if(Json.Now-result.capturedAt>120000)throw new ComputerException("OBSERVATION_STALE","观察记录已过期，请重新读取窗口。");
        return result;
      }
    }
    internal static Observation Consume(string id) {lock(gate){var result=Peek(id);observations.Remove(id);return result;}}
    internal static ElementRecord Element(Observation observation,string id) {
      var result=observation.elements.Find(item=>item.id==id);if(result==null)throw new ComputerException("ELEMENT_NOT_FOUND","控件不属于这次观察。");
      try {
        var current=result.Element.Current;var bounds=Bounds(current.BoundingRectangle);
        if(Runtime(result.Element)!=result.runtimeId||current.Name!=result.name||!Json.Same(bounds,result.NativeBounds))throw new ComputerException("OBSERVATION_STALE","控件已经变化，请重新观察。");
        if(!current.IsEnabled||current.IsOffscreen)throw new ComputerException("ELEMENT_UNAVAILABLE","控件不可交互或不在可见区域。");
        if(current.IsPassword)throw new ComputerException("SENSITIVE_INPUT","密码与认证内容请由用户输入。");
      } catch(ElementNotAvailableException) {throw new ComputerException("OBSERVATION_STALE","控件已经移除，请重新观察。");}
      return result;
    }
    internal static object PerformPattern(ElementRecord item,string action,string text) {
      object pattern;
      if(action=="invoke"&&item.Element.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();
      else if(action=="setValue"&&item.Element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
        var value=(ValuePattern)pattern;if(value.Current.IsReadOnly)throw new ComputerException("READ_ONLY","这个控件不能修改。");value.SetValue(text);
      } else if(action=="select"&&item.Element.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))((SelectionItemPattern)pattern).Select();
      else if(action=="toggle"&&item.Element.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))((TogglePattern)pattern).Toggle();
      else if(action=="expand"&&item.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))((ExpandCollapsePattern)pattern).Expand();
      else if(action=="collapse"&&item.Element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern))((ExpandCollapsePattern)pattern).Collapse();
      else if(action=="focusElement")item.Element.SetFocus();
      else throw new ComputerException("PATTERN_UNSUPPORTED","控件不支持所请求的结构化操作，请根据新观察选择其他方式。");
      return new {performed=true,method="uia",action=action};
    }
    internal static bool FocusIsPassword() {
      try {var focused=AutomationElement.FocusedElement;return focused!=null&&focused.Current.IsPassword;}catch(ElementNotAvailableException){return true;}
    }
    internal static void VerifyFocus(Observation observation) {
      if(string.IsNullOrEmpty(observation.focusedElementId))throw new ComputerException("FOCUS_UNVERIFIED","观察中没有可核实的焦点控件，请先点击或聚焦编辑区域并重新观察。");
      var expected=Element(observation,observation.focusedElementId);var focused=AutomationElement.FocusedElement;
      if(focused==null||Runtime(focused)!=expected.runtimeId)throw new ComputerException("FOCUS_CHANGED","焦点控件已经变化，请重新观察后输入。");
    }
  }
}
