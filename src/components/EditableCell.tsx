import { useState } from 'react';
import type { Company } from '../types';
import type { ClassificationDef, FieldDef } from '../lib/fields';
import { EditableField } from './EditableField';
import { ClassificationField } from './ClassificationField';

/** A table cell that reveals a full EditableField/ClassificationField editor in a small
 *  popover on click, so the funnel/watchlist tables don't require opening the full drawer
 *  just to fix one field. */
export function EditableCell({
  raw,
  display,
  fieldDef,
  classificationDef,
  liveAutomatedValue,
  liveAutomatedSource,
}: {
  raw: Company;
  display: React.ReactNode;
  fieldDef?: FieldDef;
  classificationDef?: ClassificationDef;
  liveAutomatedValue?: boolean;
  liveAutomatedSource?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="text-left hover:underline decoration-dotted underline-offset-2"
        title="Click to edit"
      >
        {display}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div
            className="absolute z-50 top-full left-0 mt-1 w-72 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {fieldDef && <EditableField raw={raw} def={fieldDef} />}
            {classificationDef && (
              <ClassificationField raw={raw} def={classificationDef} liveAutomatedValue={liveAutomatedValue} liveAutomatedSource={liveAutomatedSource} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
