using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace GrayCode.ComputerHost {
  internal sealed class CaptureResult {
    public long capturedAt;
    public string windowId,monitorId,mimeType,data,method,notice;
    public int dpi,width,height;
    public object bounds;
  }
  internal static class WindowCapture {
    // 前台窗口按实际物理区域采集，系统文件对话框也适用。后台窗口先让窗口自己绘制，
    // 画不出内容且本任务持有该窗口的控制权时，才切到前台采集一次。
    internal static object Visible(Observation observation,Dictionary<string,object> args,ControlState control) {
      DesktopWindows.RequireInteractive();var window=observation.window;DesktopWindows.Verify(window,false);
      var handle=DesktopWindows.Parse(window.id);string notice=null;
      if(!DesktopWindows.Describe(handle,false).foreground) {
        bool blank;var background=Background(handle,window,args,out blank);
        if(background!=null&&!blank){DesktopWindows.Verify(window,false);return Finish(background,window,"print-window",null);}
        var lease=Json.Text(args,"leaseId");
        if(lease.Length==0||!control.Holds(lease,handle)) {
          if(background!=null)return Finish(background,window,"print-window","后台截图只有单一颜色，窗口可能没有画出内容；取得该窗口的控制权后再观察，会自动切到前台截图。");
          throw new ComputerException("FOCUS_REQUIRED","这个窗口不在前台，后台截图也没有成功；取得该窗口的控制权后再观察，会自动切到前台截图，也可以请用户切换到该窗口。");
        }
        if(!DesktopWindows.BringToFront(handle))throw new ComputerException("FOCUS_REJECTED","后台截图没有取得画面，系统也没有把焦点交给目标窗口，请由用户切换后重新观察。");
        Thread.Sleep(120);notice="后台截图没有取得画面，已把窗口切到前台后截图。";
      }
      DesktopWindows.Verify(window,true);
      var result=Region(window.FrameBounds,args);DesktopWindows.Verify(window,true);
      return Finish(result,window,"visible-screen-region",notice);
    }
    private static CaptureResult Finish(CaptureResult result,WindowIdentity window,string method,string notice) {
      result.windowId=window.id;result.monitorId=window.monitorId;result.dpi=window.dpi;result.method=method;result.notice=notice;return result;
    }
    // PW_RENDERFULLCONTENT 让 DirectX 和合成窗口也画出内容；结果按 DWM 可见边框裁掉阴影。
    private static CaptureResult Background(IntPtr handle,WindowIdentity window,Dictionary<string,object> args,out bool blank) {
      blank=true;var full=window.NativeBounds;var frame=window.FrameBounds;
      var width=full.Right-full.Left;var height=full.Bottom-full.Top;
      if(width<1||height<1||(long)width*height>64000000)return null;
      using(var original=new Bitmap(width,height,PixelFormat.Format32bppRgb)) {
        bool printed;
        using(var graphics=Graphics.FromImage(original)){var dc=graphics.GetHdc();try{printed=Win32.PrintWindow(handle,dc,2);}finally{graphics.ReleaseHdc(dc);}}
        var capturedAt=Json.Now;if(!printed)return null;
        var crop=Rectangle.Intersect(new Rectangle(frame.Left-full.Left,frame.Top-full.Top,frame.Right-frame.Left,frame.Bottom-frame.Top),new Rectangle(0,0,width,height));
        if(crop.Width<1||crop.Height<1)crop=new Rectangle(0,0,width,height);
        using(var cropped=original.Clone(crop,PixelFormat.Format32bppRgb)) {
          blank=Uniform(cropped);
          return Encode(cropped,new Win32.Rect {Left=full.Left+crop.Left,Top=full.Top+crop.Top,Right=full.Left+crop.Right,Bottom=full.Top+crop.Bottom},args,capturedAt);
        }
      }
    }
    private static bool Uniform(Bitmap image) {
      var data=image.LockBits(new Rectangle(0,0,image.Width,image.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppRgb);
      try {
        int first=0;const int steps=24;
        for(var row=0;row<=steps;row++)for(var column=0;column<=steps;column++) {
          var x=Math.Min(image.Width-1,column*image.Width/steps);var y=Math.Min(image.Height-1,row*image.Height/steps);
          var pixel=Marshal.ReadInt32(data.Scan0,y*data.Stride+x*4)&0xFFFFFF;
          if(row==0&&column==0)first=pixel;else if(pixel!=first)return false;
        }
        return true;
      } finally {image.UnlockBits(data);}
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
      using(var original=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
        using(var graphics=Graphics.FromImage(original))graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
        return Encode(original,bounds,args,Json.Now);
      }
    }
    private static CaptureResult Encode(Bitmap original,Win32.Rect bounds,Dictionary<string,object> args,long capturedAt) {
      var width=original.Width;var height=original.Height;
      var maxWidth=Math.Max(320,Math.Min(2560,Json.Number(args,"width",1600)));var maxHeight=Math.Max(240,Math.Min(2160,Json.Number(args,"height",1200)));
      var factor=Math.Min(1,Math.Min((double)maxWidth/width,(double)maxHeight/height));var imageWidth=Math.Max(1,(int)Math.Round(width*factor));var imageHeight=Math.Max(1,(int)Math.Round(height*factor));
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
