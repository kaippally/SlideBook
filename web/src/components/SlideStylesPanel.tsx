import { BTN_OFF, Group, Section, SectionColumns, Slider, Toggle, ColorAlpha } from './slideControls';
import { DEFAULT_SURFACE_Y, resolveSurface, type SlidePageStyle, type SlideSurface } from './slideStyles';

/**
 * Slide look editor, in two bands that say what they act on. THIS SLIDE: video volume, slab and drop
 * shadow ("Copy to all pages" spreads them). WHOLE DECK: surface reflection and the background video.
 */
export function SlideStylesPanel({ pageNum, pageCount, page, surface, onChange, onSurfaceChange, onApplyAll, title, scope }: {
  pageNum: number | null;
  pageCount: number;
  page: SlidePageStyle | null;
  surface: SlideSurface | null;
  onChange: (patch: Partial<SlidePageStyle>) => void;
  onSurfaceChange: (patch: Partial<SlideSurface>) => void;
  onApplyAll?: () => void;
  /** Another object than a page (the video object): one group, its own surface. */
  title?: string;
  scope?: string;
}) {
  if (!page || pageNum == null) {
    return (
      <div className="h-full flex items-center justify-center bg-[#0b0d10] text-slate-600 text-[11px] italic px-4 text-center">
        Select a book and a page to style it.
      </div>
    );
  }
  const p = page;
  const sf = surface ?? resolveSurface();
  return (
    <SectionColumns.Provider value>
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[#0b0d10] text-slate-300">
      <Group title={title ?? `Page ${pageNum}`} scope={scope ?? `of ${pageCount} · this page only`}>
        {onApplyAll && (
          <div className="flex justify-end px-3 pt-2">
            <button onClick={onApplyAll} className={BTN_OFF} title="Copy this slide's slab and drop shadow to every slide">Copy to all pages</button>
          </div>
        )}
        <Section title="Slab">
          <Slider label="Thickness" value={p.thickness ?? 0} min={0} max={120} suffix="px" onChange={v => onChange({ thickness: v })} />
        </Section>
        <Section title="Drop shadow">
          <Slider label="Blur" value={p.shadowBlur} min={0} max={100} suffix="px" onChange={v => onChange({ shadowBlur: v })} />
          <Slider label="Offset X" value={p.shadowX} min={-100} max={100} suffix="px" onChange={v => onChange({ shadowX: v })} />
          <Slider label="Offset Y" value={p.shadowY} min={-100} max={100} suffix="px" onChange={v => onChange({ shadowY: v })} />
          <ColorAlpha label="Colour" value={p.shadowColor} onChange={v => onChange({ shadowColor: v })} />
        </Section>
      </Group>

      <Group title={title ? `${title} surface` : 'Whole book'} scope={title ? 'its own reflection' : 'every slide'}>
        <Section title="Surface reflection">
          <Toggle label="Reflection" value={!!sf.reflection} onChange={v => onSurfaceChange({ reflection: v })} />
          {/* Off = a flat 2D mirror across the surface line (as it was). On = the reflection lies on the
              perspective grid floor and recedes with it (a true 3D floor mirror). */}
          <Toggle label="On grid" value={!!sf.reflectionGrid} onChange={v => onSurfaceChange({ reflectionGrid: v })} />
          <Slider label="Surface Y" value={Math.round((sf.reflectionSurfaceY ?? DEFAULT_SURFACE_Y) * 100)} min={0} max={100} suffix="%" onChange={v => onSurfaceChange({ reflectionSurfaceY: v / 100 })} />
          <Slider label="Object %" value={sf.reflectionOpacityMain ?? 100} min={0} max={100} suffix="%" onChange={v => onSurfaceChange({ reflectionOpacityMain: v })} />
          <Slider label="Reflect %" value={sf.reflectionOpacity ?? 50} min={0} max={100} suffix="%" onChange={v => onSurfaceChange({ reflectionOpacity: v })} />
          <Slider label="Distance" value={sf.reflectionDistance ?? 0} min={0} max={1400} suffix="px" onChange={v => onSurfaceChange({ reflectionDistance: v })} />
          <Slider label="Feather" value={sf.reflectionFeather ?? 67} min={0} max={100} suffix="%" onChange={v => onSurfaceChange({ reflectionFeather: v })} />
          <Slider label="Blur" value={sf.reflectionBlur ?? 0} min={0} max={40} suffix="px" onChange={v => onSurfaceChange({ reflectionBlur: v })} />
        </Section>
      </Group>
    </div>
    </SectionColumns.Provider>
  );
}
