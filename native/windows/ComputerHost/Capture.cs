using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace GrayCode.ComputerHost {
  internal sealed class CaptureResult {
    public long capturedAt;
    public string windowId,monitorId,mimeType,data,method;
    public int dpi,width,height;
    public object bounds;
  }
  internal static class WindowCapture {
    // 系统文件对话框不一定出现在窗口共享目录中，前台窗口可以按实际物理区域采集。
    internal static object Visible(Observation observation,Dictionary<string,object> args) {
      DesktopWindows.RequireInteractive();DesktopWindows.Verify(observation.window,true);
      var result=Region(observation.window.FrameBounds,args);DesktopWindows.Verify(observation.window,true);
      result.windowId=observation.window.id;result.monitorId=observation.window.monitorId;result.dpi=observation.window.dpi;result.method="visible-screen-region";
      return result;
    }
    // 显示器画面只用于观看；输入仍必须绑定具体窗口及其有效观察。
    internal static object Display(Dictionary<string,object> args) {
      DesktopWindows.RequireInteractive();var id=Json.Text(args,"monitorId");uint scale;var info=Monitor(id,out scale);
      var result=Region(info.Monitor,args);uint nextScale;var next=Monitor(id,out nextScale);DesktopWindows.RequireInteractive();
      if(!Json.Same(info.Monitor,next.Monitor)||scale!=nextScale)throw new ComputerException("CAPTURE_GEOMETRY_CHANGED","显示器位置、尺寸或缩放已改变，请重新采集。");
      result.monitorId=id;result.dpi=(int)Math.Round(96*scale/100.0);result.method="display";return result;
    }
    private static Win32.MonitorInfo Monitor(string id,out uint scale) {
      var found=false;uint factor=100;var selected=new Win32.MonitorInfo();
      Win32.EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,delegate(IntPtr monitor,IntPtr dc,ref Win32.Rect rect,IntPtr ignored) {
        var info=new Win32.MonitorInfo{Size=Marshal.SizeOf(typeof(Win32.MonitorInfo))};
        if(Win32.GetMonitorInfo(monitor,ref info)&&info.Device==id){selected=info;found=true;try{Win32.GetScaleFactorForMonitor(monitor,out factor);}catch(EntryPointNotFoundException){}return false;}return true;
      },IntPtr.Zero);
      if(!found)throw new ComputerException("DISPLAY_NOT_FOUND","所选显示器不可用，请刷新显示器列表。");scale=factor;return selected;
    }
    private static CaptureResult Region(Win32.Rect bounds,Dictionary<string,object> args) {
      var width=bounds.Right-bounds.Left;var height=bounds.Bottom-bounds.Top;
      var desktop=new Rectangle(Win32.GetSystemMetrics(76),Win32.GetSystemMetrics(77),Win32.GetSystemMetrics(78),Win32.GetSystemMetrics(79));
      if(width<1||height<1||(long)width*height>64000000||!desktop.Contains(new Rectangle(bounds.Left,bounds.Top,width,height)))
        throw new ComputerException("CAPTURE_BOUNDS_UNAVAILABLE","窗口没有完整显示在桌面区域内，请移动或缩小窗口后重新观察。");
      var maxWidth=Math.Max(320,Math.Min(2560,Json.Number(args,"width",1600)));var maxHeight=Math.Max(240,Math.Min(2160,Json.Number(args,"height",1200)));
      var factor=Math.Min(1,Math.Min((double)maxWidth/width,(double)maxHeight/height));var imageWidth=Math.Max(1,(int)Math.Round(width*factor));var imageHeight=Math.Max(1,(int)Math.Round(height*factor));
      using(var original=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
        using(var graphics=Graphics.FromImage(original))graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
        var capturedAt=Json.Now;
        using(var scaled=new Bitmap(imageWidth,imageHeight,PixelFormat.Format32bppArgb)) {
          using(var graphics=Graphics.FromImage(scaled)){graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(original,new Rectangle(0,0,imageWidth,imageHeight));}
          using(var stream=new MemoryStream()) {
            var jpeg=Json.Text(args,"format")=="jpeg";
            if(jpeg) {
              ImageCodecInfo codec=null;foreach(var item in ImageCodecInfo.GetImageEncoders())if(item.MimeType=="image/jpeg"){codec=item;break;}
              using(var parameters=new EncoderParameters(1)){parameters.Param[0]=new EncoderParameter(Encoder.Quality,(long)Math.Max(50,Math.Min(95,Json.Number(args,"quality",85))));scaled.Save(stream,codec,parameters);}
            } else scaled.Save(stream,ImageFormat.Png);
            return new CaptureResult {capturedAt=capturedAt,bounds=Json.Rect(bounds),width=imageWidth,height=imageHeight,mimeType=jpeg?"image/jpeg":"image/png",data=Convert.ToBase64String(stream.ToArray())};
          }
        }
      }
    }
  }
}
