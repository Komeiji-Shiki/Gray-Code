using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;

namespace GrayCode.ComputerHost {
  internal sealed class ComputerException : Exception {
    internal readonly string Code;
    internal ComputerException(string code, string message) : base(message) { Code=code; }
  }
  internal static class Json {
    internal static Dictionary<string,object> Map(object value) { return value as Dictionary<string,object> ?? new Dictionary<string,object>(); }
    internal static string Text(Dictionary<string,object> value,string key,string fallback="") { object item; return value.TryGetValue(key,out item)&&item!=null?Convert.ToString(item,CultureInfo.InvariantCulture):fallback; }
    internal static bool Flag(Dictionary<string,object> value,string key,bool fallback=false) { object item; return value.TryGetValue(key,out item)&&item is bool?(bool)item:fallback; }
    internal static int Number(Dictionary<string,object> value,string key,int fallback=0) { object item; return value.TryGetValue(key,out item)&&item!=null?Convert.ToInt32(item,CultureInfo.InvariantCulture):fallback; }
    internal static IEnumerable<string> Strings(Dictionary<string,object> value,string key) {
      object item; if(!value.TryGetValue(key,out item))yield break;
      var values=item as IEnumerable;if(values==null||item is string)yield break;
      foreach(var part in values)yield return Convert.ToString(part,CultureInfo.InvariantCulture);
    }
    internal static long Now { get { return (long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; } }
    internal static object Rect(Win32.Rect r) { return new { x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top }; }
    internal static bool Same(Win32.Rect a,Win32.Rect b) { return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom; }
  }
}
