using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace GrayCode.ComputerHost {
  internal static class Program {
    private static readonly object outputGate=new object(),operationGate=new object();
    private static readonly BlockingCollection<Dictionary<string,object>> operations=new BlockingCollection<Dictionary<string,object>>();
    private static readonly JavaScriptSerializer serializer=new JavaScriptSerializer {MaxJsonLength=32*1024*1024,RecursionLimit=100};
    private static ControlState control;
    private static SynchronizationContext dispatcher;
    private static volatile bool closing;
    private static void Write(object value) {lock(outputGate){Console.WriteLine(serializer.Serialize(value));Console.Out.Flush();}}
    [STAThread] private static void Main() {
      Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
      try {Win32.SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){Win32.SetProcessDPIAware();}
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());dispatcher=SynchronizationContext.Current;
      try {
        control=new ControlState();control.Changed+=delegate(object status){Write(new {eventType="control.changed",status=status});};
        var worker=new Thread(delegate(){foreach(var request in operations.GetConsumingEnumerable()){if(closing)return;Execute(request);}});worker.IsBackground=true;worker.Start();
        var reader=new Thread(Read);reader.IsBackground=true;reader.Start();
        Write(new {ready=true,protocol=1,processId=Process.GetCurrentProcess().Id});
        Application.Run(new ApplicationContext());
      } catch(Exception error) {Write(new {fatal=true,code="HOST_UNAVAILABLE",error=error.Message});Environment.ExitCode=1;}
      finally {closing=true;operations.CompleteAdding();if(control!=null)control.Dispose();}
    }
    private static void Read() {
      try {
        string line;while(!closing&&(line=Console.ReadLine())!=null) {
          Dictionary<string,object> request;
          try {request=Json.Map(serializer.DeserializeObject(line));}
          catch(Exception error) {Write(new {id=(object)null,error=new {code="INVALID_REQUEST",message=error.Message}});continue;}
          var method=Json.Text(request,"method");
          if(method=="stop"||method=="release"||method=="quit") {
            object supplied;request.TryGetValue("params",out supplied);
            control.Stop(method=="quit"?"host_closed":Json.Text(Json.Map(supplied),"reason","requested"));AutomationState.Clear();
            object id;request.TryGetValue("id",out id);Write(new {id=id,result=control.Status()});
            if(method=="quit"){closing=true;dispatcher.Post(delegate(object ignored){Application.ExitThread();},null);return;}
          } else {
            operations.Add(request);
          }
        }
      } finally {
        if(!closing){control.Stop("parent_disconnected");closing=true;dispatcher.Post(delegate(object ignored){Application.ExitThread();},null);}
      }
    }
    private static void Execute(Dictionary<string,object> request) {
      object id;request.TryGetValue("id",out id);
      try {
        lock(operationGate) {
          if(closing)throw new ComputerException("HOST_CLOSED","电脑操作宿主正在关闭。");
          object raw;request.TryGetValue("params",out raw);var args=Json.Map(raw);object result;
          switch(Json.Text(request,"method")) {
            case "status":result=control.Status();break;
            case "windows":result=DesktopWindows.List();break;
            case "observe":result=AutomationState.Observe(args);break;
            case "capture":result=WindowCapture.Visible(AutomationState.Peek(Json.Text(args,"observationId")),args);break;
            case "displayCapture":result=WindowCapture.Display(args);break;
            case "validate":var observed=AutomationState.Peek(Json.Text(args,"observationId"));DesktopWindows.Verify(observed.window,false);result=new {valid=true};break;
            case "acquire":result=control.Acquire(Json.Text(args,"owner"),Json.Strings(args,"windowIds"));break;
            case "action":result=InputActions.Perform(control,AutomationState.Consume(Json.Text(args,"observationId")),args);break;
            default:throw new ComputerException("METHOD_UNSUPPORTED","不支持的宿主请求。");
          }
          Write(new {id=id,result=result});
        }
      } catch(ComputerException error) {Write(new {id=id,error=new {code=error.Code,message=error.Message}});}
      catch(Exception error) {Write(new {id=id,error=new {code="OPERATION_FAILED",message=error.Message}});}
    }
  }
}
